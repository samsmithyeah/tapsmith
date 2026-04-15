//! HTTP/HTTPS forward proxy for network traffic capture during tracing.
//!
//! Starts a local TCP proxy that intercepts HTTP and HTTPS requests from the
//! device (configured via `adb shell settings put global http_proxy`). For
//! HTTPS, performs MITM interception using per-host certificates signed by
//! the Pilot CA to decrypt and capture request/response content.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, info, warn};

use crate::mitm_ca::MitmAuthority;

/// Timeout for connecting to upstream servers.
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for individual read operations from upstream.
const UPSTREAM_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for reading initial request headers from a client.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum request/response body size to capture (1 MB). Only used for storage
/// in CapturedEntry — the proxy pipeline uses MAX_PROXY_BODY to avoid truncating
/// forwarded traffic.
const MAX_BODY_SIZE: usize = 1_048_576;
/// Maximum body size to read through the proxy pipeline (10 MB). This is higher
/// than MAX_BODY_SIZE because we need to forward complete requests/responses to
/// upstream even though we only store a truncated copy in the capture.
const MAX_PROXY_BODY: usize = 10 * 1024 * 1024;

/// Hosts that must bypass MITM interception and forward as raw TCP to the
/// upstream server. These are endpoints iOS uses to verify developer cert
/// trust (OCSP / CRL / device enrollment). If we MITM them with our own CA,
/// iOS rejects the response and refuses to launch freshly-signed test runners
/// with "invalid code signature, inadequate entitlements or its profile has
/// not been explicitly trusted by the user" — a confusing umbrella error that
/// cost us hours of debugging the first time we hit it. Matched as exact
/// suffixes (case-insensitive) against the CONNECT target hostname.
const MITM_PASSTHROUGH_SUFFIXES: &[&str] = &[
    // Apple OCSP / CRL / device trust verification
    "ocsp.apple.com",
    "ocsp2.apple.com",
    "ocsp.digicert.com",
    "crl.apple.com",
    "crl3.digicert.com",
    "crl4.digicert.com",
    "ppq.apple.com",
    "ppq.apple.com.akadns.net",
    // Apple certificate status / validation infrastructure
    "valid.apple.com",
    "certs.apple.com",
];

fn is_mitm_passthrough_host(hostname: &str) -> bool {
    let host = hostname.to_ascii_lowercase();
    MITM_PASSTHROUGH_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// A captured network request/response pair.
#[derive(Debug, Clone)]
pub struct CapturedEntry {
    pub method: String,
    pub url: String,
    pub status_code: i32,
    pub content_type: String,
    pub request_size: u64,
    pub response_size: u64,
    pub start_time_ms: u64,
    pub duration_ms: u64,
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub request_body: Vec<u8>,
    pub response_body: Vec<u8>,
    pub is_https: bool,
}

/// A decoded HTTP request, structured for transformation hooks.
///
/// `raw_bytes` is the complete request bytes (headers + body) as received on
/// the wire — forwarded upstream as-is when no transformation is applied.
/// `body` is the body portion alone, for use in capture and by future
/// modification handlers.
#[derive(Debug, Clone)]
pub(crate) struct ParsedRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub raw_bytes: Vec<u8>,
}

/// A decoded HTTP response, structured for transformation hooks.
///
/// Same `raw_bytes` / `body` split as [`ParsedRequest`].
#[derive(Debug, Clone)]
pub(crate) struct ParsedResponse {
    pub status_code: i32,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub raw_bytes: Vec<u8>,
}

/// Hook trait for request/response transformation and synthetic responses.
///
/// All methods have no-op defaults. PILOT-182 adds the insertion points but
/// no actual handler implementations — request/response modification is a
/// separate roadmap feature that will build on this scaffolding.
#[async_trait::async_trait]
pub(crate) trait NetworkHandler: Send + Sync {
    /// Inspect (and optionally mutate) a request before it's forwarded to
    /// upstream. If this returns `Some(resp)`, the upstream call is skipped
    /// and `resp` is returned directly to the client — this is how synthetic
    /// responses / route-stubbing will work in the future.
    async fn on_request(&self, _req: &mut ParsedRequest) -> Option<ParsedResponse> {
        None
    }

    /// Inspect (and optionally mutate) a response before it's written back
    /// to the client. Used for header/body rewriting.
    async fn on_response(&self, _req: &ParsedRequest, _resp: &mut ParsedResponse) {}
}

/// Shared state for the proxy server.
pub(crate) struct ProxyState {
    entries: Vec<CapturedEntry>,
    tls_client_config: Arc<ClientConfig>,
    /// Optional transformation handler. `None` today (PILOT-182); populated
    /// later when request/response modification lands. The handler field is
    /// read from inside `handle_mitm_http` — even though it's always `None`
    /// at runtime, the code path exists and the types are exercised, so the
    /// future roadmap work is a pure drop-in.
    handler: Option<Arc<dyn NetworkHandler>>,
}

/// Handle to the running proxy. Dropping it stops the proxy.
pub struct NetworkProxy {
    port: u16,
    state: Arc<Mutex<ProxyState>>,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

impl NetworkProxy {
    /// Start the proxy on an ephemeral loopback port (the default for
    /// simulators and Android devices, which reach the proxy via transparent
    /// redirection or `adb reverse`).
    ///
    /// The `mitm_ca` is used to generate per-host TLS certificates for HTTPS
    /// interception.
    pub async fn start(mitm_ca: Arc<MitmAuthority>) -> Result<Self> {
        Self::start_on(mitm_ca, "127.0.0.1:0".parse().expect("valid ipv4 addr")).await
    }

    /// Start the proxy on a specific bind address and port.
    ///
    /// Physical iOS devices (PILOT-185) cannot reach `127.0.0.1` on the host
    /// — they have their own loopback. Instead, a mobileconfig installs a
    /// Wi-Fi HTTP proxy pointing at the host's local LAN IP + a deterministic
    /// per-UDID port. Binding on `0.0.0.0:<port>` makes the proxy reachable
    /// over the LAN so the device's HTTP proxy directs traffic into it.
    ///
    /// Loopback binds are still preferred anywhere the caller doesn't need
    /// LAN exposure — an open `0.0.0.0` listener would let any host on the
    /// local network reach the MITM proxy, which is not what simulator tests
    /// want. The shim helper `start` above picks `127.0.0.1:0` on behalf of
    /// callers that don't care.
    pub async fn start_on(mitm_ca: Arc<MitmAuthority>, bind_addr: SocketAddr) -> Result<Self> {
        let listener = TcpListener::bind(bind_addr)
            .await
            .with_context(|| format!("Failed to bind proxy port at {bind_addr}"))?;
        let port = listener.local_addr()?.port();

        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls_client_config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );

        let state = Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config,
            handler: None,
        }));

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let state_clone = state.clone();
        tokio::spawn(async move {
            info!(port, "Network capture proxy started (MITM enabled)");
            loop {
                tokio::select! {
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                let st = state_clone.clone();
                                let ca = mitm_ca.clone();
                                tokio::spawn(handle_connection(stream, addr, st, ca));
                            }
                            Err(e) => {
                                warn!("Proxy accept error: {e}");
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        info!("Network capture proxy stopping");
                        break;
                    }
                }
            }
        });

        Ok(Self {
            port,
            state,
            shutdown_tx,
        })
    }

    /// The port the proxy is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Clone the shared `ProxyState` handle so modules like `ios_redirect`
    /// can feed transparent-TCP flows into [`handle_transparent_tcp`] without
    /// needing to wrap `NetworkProxy` itself in `Arc` (`stop(self)` still
    /// consumes the outer handle cleanly). Only used on macOS — the Linux
    /// build has no transparent-TCP entry point.
    #[cfg(target_os = "macos")]
    pub(crate) fn state_handle(&self) -> Arc<Mutex<ProxyState>> {
        self.state.clone()
    }

    /// Clear any captured entries without stopping the proxy. Used when a
    /// test session starts network capture on a proxy that was pre-started
    /// for OCSP passthrough during agent launch — pre-start OCSP/CRL traffic
    /// would otherwise leak into the captured entries of the first test.
    pub async fn reset_entries(&self) {
        let mut state = self.state.lock().await;
        state.entries.clear();
    }

    /// Stop the proxy and return all captured entries.
    pub async fn stop(self) -> Vec<CapturedEntry> {
        let _ = self.shutdown_tx.send(());
        // Give in-flight requests a moment to complete
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let state = self.state.lock().await;
        state.entries.clone()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Handle a single proxy connection.
async fn handle_connection(
    mut client: TcpStream,
    addr: SocketAddr,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) {
    debug!(%addr, "New proxy connection");

    // Read the initial request line + headers (loop until \r\n\r\n)
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 8192];
    loop {
        match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read(&mut tmp)).await {
            Ok(Ok(0)) => return,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 65536 {
                    debug!("Proxy request headers too large");
                    return;
                }
            }
            Ok(Err(e)) => {
                debug!("Read error from proxy client: {e}");
                return;
            }
            Err(_) => {
                debug!("Proxy client header read timed out");
                return;
            }
        }
    }

    let request_str = String::from_utf8_lossy(&buf);
    let first_line = request_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    if parts.len() < 3 {
        debug!("Invalid HTTP request line: {first_line}");
        return;
    }

    let method = parts[0];
    let target = parts[1];

    if method == "CONNECT" {
        handle_connect(client, target, state, mitm_ca).await;
    } else {
        handle_http(client, method, target, &buf, state).await;
    }
}

/// Create a 502 error entry for a failed CONNECT attempt.
fn connect_error_entry(target: &str) -> CapturedEntry {
    CapturedEntry {
        method: "CONNECT".to_string(),
        url: format!("https://{target}"),
        status_code: 502,
        content_type: String::new(),
        request_size: 0,
        response_size: 0,
        start_time_ms: now_ms(),
        duration_ms: 0,
        request_headers: Vec::new(),
        response_headers: Vec::new(),
        request_body: Vec::new(),
        response_body: Vec::new(),
        is_https: true,
    }
}

/// Handle HTTP CONNECT with MITM TLS interception.
///
/// 1. Connect to upstream server
/// 2. Tell client the tunnel is established
/// 3. TLS handshake with upstream (as a client)
/// 4. TLS accept from our client (using a per-host cert signed by our CA)
/// 5. Proxy decrypted HTTP traffic between the two TLS streams, capturing everything
async fn handle_connect(
    mut client: TcpStream,
    target: &str,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) {
    // Parse hostname (strip port)
    let hostname = target.split(':').next().unwrap_or(target).to_string();
    let connect_target = if target.contains(':') {
        target.to_string()
    } else {
        format!("{target}:443")
    };

    // Connect to the real upstream server
    let upstream_tcp = match tokio::time::timeout(
        UPSTREAM_CONNECT_TIMEOUT,
        TcpStream::connect(&connect_target),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            debug!("CONNECT failed to {connect_target}: {e}");
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
            state.lock().await.entries.push(connect_error_entry(target));
            return;
        }
        Err(_) => {
            debug!("CONNECT timed out to {connect_target}");
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
            state.lock().await.entries.push(connect_error_entry(target));
            return;
        }
    };

    // Tell the client the tunnel is established
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }

    // Passthrough: if this is a host iOS uses to verify developer cert trust
    // (OCSP / CRL), forward raw TCP and skip MITM. Interfering with these
    // blocks iOS from launching freshly-signed test runners.
    if is_mitm_passthrough_host(&hostname) {
        debug!("CONNECT passthrough (no MITM) for {hostname}");
        let mut upstream = upstream_tcp;
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        return;
    }

    // TLS handshake with upstream using shared root certificates
    let tls_client_config = state.lock().await.tls_client_config.clone();

    let server_name = match rustls::pki_types::ServerName::try_from(hostname.clone()) {
        Ok(sn) => sn,
        Err(e) => {
            debug!("Invalid server name '{hostname}': {e}");
            return;
        }
    };

    let tls_connector = TlsConnector::from(tls_client_config);
    let upstream_tls = match tls_connector.connect(server_name, upstream_tcp).await {
        Ok(s) => s,
        Err(e) => {
            debug!("TLS handshake with upstream {hostname} failed: {e}");
            return;
        }
    };

    // Generate a per-host cert signed by our CA and accept TLS from the client
    let server_config = match mitm_ca.server_config_for_host(&hostname).await {
        Ok(cfg) => cfg,
        Err(e) => {
            debug!("Failed to generate MITM cert for {hostname}: {e}");
            return;
        }
    };

    let tls_acceptor = TlsAcceptor::from(server_config);
    let client_tls = match tls_acceptor.accept(client).await {
        Ok(s) => s,
        Err(e) => {
            debug!("TLS handshake with client for {hostname} failed: {e}");
            return;
        }
    };

    // Both sides are now decrypted — proxy HTTP traffic and capture it.
    // CONNECT-tunnel path is always HTTPS by definition.
    handle_mitm_http(
        client_tls,
        upstream_tls,
        &hostname,
        state,
        /* is_https */ true,
    )
    .await;
}

/// Outcome of reading a request or response from a stream. `ConnectionClosed`
/// is a clean EOF; `Error` is anything else (timeout, IO error, malformed
/// bytes, oversized headers). Callers treat both as "stop this iteration".
enum ReadOutcome<T> {
    Ok(T),
    ConnectionClosed,
    Error,
}

/// Search for the `\r\n\r\n` header terminator in `buf`, scanning only the
/// new bytes since the last call. Returns the byte offset of the first
/// terminator (end of the terminator, i.e. start of the body) if found.
///
/// Avoids O(N²) header search for large buffers that grow over many reads:
/// callers advance `scan_cursor` to `buf.len()` after each call, and we
/// start 3 bytes earlier on the next call to handle the case where
/// `\r\n\r` was at the tail of the previous read and `\n` arrives next.
fn find_header_terminator(buf: &[u8], scan_cursor: usize) -> Option<usize> {
    let start = scan_cursor.saturating_sub(3);
    buf[start..]
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| start + pos + 4)
}

/// Returns true if any `Transfer-Encoding` header carries `chunked` as
/// one of its comma-separated transfer codings. Walks every matching
/// header (HTTP/1.1 allows multiple), splits each on `,`, trims, and
/// compares each token case-insensitively against exactly `chunked`.
///
/// Strict token matching defends against header-smuggling tricks that
/// exploit a substring search: `Transfer-Encoding: notchunked` or
/// `Transfer-Encoding: chunkedz` would have matched a naive
/// `contains("chunked")` check. See PILOT-182 review #5 finding SF3.
fn is_chunked_transfer_encoding(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, v)| v.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("chunked"))
}

/// Returns true if the headers carry a `Content-Length`. Used alongside
/// [`is_chunked_transfer_encoding`] to detect the smuggling-bait case
/// where both framing headers are present — RFC 7230 §3.3.3 requires
/// servers to reject such messages.
fn has_content_length(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("content-length"))
}

/// Returns true if any `Connection` header contains the `close` token.
///
/// `Connection` is a comma-separated list (RFC 7230 §6.1), so
/// `Connection: keep-alive, close` and multiple `Connection` headers both
/// need to match `close`. Matches tokens strictly (`eq_ignore_ascii_case`
/// after trim) so tricks like `Connection: closed` or `Connection: not-close`
/// don't false-positive.
fn has_connection_close(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, v)| v.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("close"))
}

/// Read a full HTTP/1.x request (headers + body) from a client stream,
/// returning structured request data plus the raw bytes for forwarding.
///
/// Body framing follows RFC 7230:
///   - `Transfer-Encoding: chunked` takes precedence over `Content-Length`
///     and is parsed strictly via [`read_chunked_body`].
///   - `Content-Length: N` reads exactly `N` body bytes via `read_exact`.
///     If `N > MAX_PROXY_BODY`, the connection is rejected (closing) rather
///     than silently truncating, which would desync the connection.
///   - Neither header → no body (matches GET/HEAD/OPTIONS/DELETE without body).
///
/// Requests carrying BOTH `Transfer-Encoding: chunked` AND `Content-Length`
/// are rejected as smuggling-bait per RFC 7230 §3.3.3.
async fn read_request<R>(client: &mut R, hostname: &str) -> ReadOutcome<ParsedRequest>
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 8192];
    let mut scan_cursor = 0usize;
    let header_end = loop {
        match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read(&mut tmp)).await {
            Ok(Ok(0)) => return ReadOutcome::ConnectionClosed,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(h) = find_header_terminator(&buf, scan_cursor) {
                    break h;
                }
                scan_cursor = buf.len();
                if buf.len() > 65536 {
                    debug!("MITM request headers too large for {hostname}");
                    return ReadOutcome::Error;
                }
            }
            Ok(Err(e)) => {
                debug!("MITM read from client for {hostname}: {e}");
                return ReadOutcome::Error;
            }
            Err(_) => {
                debug!("MITM client header read timed out for {hostname}");
                return ReadOutcome::Error;
            }
        }
    };

    let first_line_end = buf.iter().position(|&b| b == b'\n').unwrap_or(0);
    let first_line_str = String::from_utf8_lossy(&buf[..first_line_end]);
    let first_line = first_line_str.trim();
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 3 {
        debug!("Invalid MITM HTTP request line: {first_line}");
        return ReadOutcome::Error;
    }

    let method = parts[0].to_string();
    let path = parts[1].to_string();
    // `parse_headers` returns the same header_end we already computed; we
    // recompute here to get the structured Vec<(String, String)>.
    let (headers, _) = parse_headers(&buf[..header_end]);

    let is_chunked = is_chunked_transfer_encoding(&headers);
    let has_cl = has_content_length(&headers);

    // RFC 7230 §3.3.3: reject messages bearing BOTH Transfer-Encoding and
    // Content-Length. An upstream that interprets one header while we
    // interpret the other is a request-smuggling vector — forwarding the
    // original conflicting headers verbatim turns this proxy into a
    // smuggling relay. (PILOT-182 review #5 finding SF1.)
    if is_chunked && has_cl {
        debug!(
            "MITM rejecting request with both Transfer-Encoding and Content-Length \
             for {hostname} (RFC 7230 §3.3.3)"
        );
        return ReadOutcome::Error;
    }

    if is_chunked {
        if let Err(e) = read_chunked_body(client, &mut buf, header_end, hostname).await {
            debug!("MITM chunked request body read failed for {hostname}: {e}");
            return ReadOutcome::Error;
        }
    } else {
        // Content-Length path.
        let declared_length: Option<usize> =
            get_header(&headers, "content-length").and_then(|v| v.trim().parse::<usize>().ok());
        if let Some(cl) = declared_length {
            // Reject oversized declared bodies up-front rather than truncating —
            // silent truncation desyncs the connection (PILOT-182 review #4
            // finding S1: upstream waits for the missing bytes, the leftover
            // bytes in the client's socket buffer get parsed as the next
            // request, and the connection hangs).
            if cl > MAX_PROXY_BODY {
                debug!(
                    "MITM rejecting request with oversized Content-Length for {hostname}: \
                     {cl} > {MAX_PROXY_BODY}"
                );
                return ReadOutcome::Error;
            }
            let body_so_far = buf.len().saturating_sub(header_end);
            if cl > body_so_far {
                let remaining = cl - body_so_far;
                let mut body_buf = vec![0u8; remaining];
                match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read_exact(&mut body_buf))
                    .await
                {
                    Ok(Ok(_)) => buf.extend_from_slice(&body_buf),
                    Ok(Err(e)) => {
                        debug!("MITM reading request body for {hostname}: {e}");
                        return ReadOutcome::Error;
                    }
                    Err(_) => {
                        debug!("MITM client body read timed out for {hostname}");
                        return ReadOutcome::Error;
                    }
                }
            }
        }
        // No Content-Length and no chunked → no body (the common GET case).
    }

    let body = if header_end < buf.len() {
        buf[header_end..].to_vec()
    } else {
        Vec::new()
    };

    ReadOutcome::Ok(ParsedRequest {
        method,
        path,
        headers,
        body,
        raw_bytes: buf,
    })
}

/// Strict HTTP/1.1 chunked body parser used by [`read_request`]. Reads chunks
/// from `client` and appends them to `buf` until the terminating `0\r\n\r\n`
/// (with optional trailers) is consumed.
///
/// Why strict parsing and not the scan-based approach used by `read_response`:
///   1. Requests can be pipelined on a keep-alive connection. Over-reading
///      past the chunked terminator would consume the next request's bytes
///      and lose them.
///   2. The `\r\n0\r\n` substring scan in `read_response` is heuristic —
///      `0\r\n` can legitimately appear inside a data chunk. Strict parsing
///      reads chunk-size headers and exact-size data payloads, so it can't
///      false-match on intra-chunk bytes.
///
/// Chunked grammar (RFC 7230 §4.1):
///     chunked-body  = *chunk last-chunk trailer-section CRLF
///     chunk         = chunk-size [ chunk-ext ] CRLF chunk-data CRLF
///     last-chunk    = "0" [ chunk-ext ] CRLF
///     trailer-section = *( header-field CRLF )
///
/// Aborts with `Err` on: connection closed mid-message, chunk size > remaining
/// `MAX_PROXY_BODY` budget, malformed chunk-size line, or read timeout.
async fn read_chunked_body<R>(
    client: &mut R,
    buf: &mut Vec<u8>,
    header_end: usize,
    hostname: &str,
) -> Result<(), &'static str>
where
    R: AsyncRead + Unpin,
{
    let mut cursor = header_end;

    /// Helper: ensure buf contains the byte at `index` by reading more if
    /// needed. Returns Err if the stream closes or the buffer would exceed
    /// MAX_PROXY_BODY.
    async fn ensure_at_least<R>(
        client: &mut R,
        buf: &mut Vec<u8>,
        target_len: usize,
        hostname: &str,
    ) -> Result<(), &'static str>
    where
        R: AsyncRead + Unpin,
    {
        if target_len > MAX_PROXY_BODY {
            debug!("chunked body exceeds MAX_PROXY_BODY for {hostname}");
            return Err("body too large");
        }
        while buf.len() < target_len {
            let need = target_len - buf.len();
            let mut chunk = vec![0u8; need.min(8192)];
            match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read(&mut chunk)).await {
                Ok(Ok(0)) => return Err("client closed mid-chunked-body"),
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
                Ok(Err(_)) => return Err("read error mid-chunked-body"),
                Err(_) => return Err("chunked body read timed out"),
            }
        }
        Ok(())
    }

    /// Helper: ensure buf contains a complete `\r\n`-terminated line starting
    /// at `cursor`. Returns the index of the byte AFTER the terminator.
    ///
    /// **Reads exactly one byte at a time** (via `read_u8`) rather than
    /// pulling a larger chunk off the stream. This is slow per-byte but
    /// correct: it guarantees we never pull bytes belonging to a subsequent
    /// pipelined request into our buffer. Chunk-size lines and trailer
    /// lines are short (typically <20 bytes total per chunked body), so
    /// the extra syscalls are negligible in the PILOT-182 use case.
    ///
    /// A prior implementation used a 256-byte buffered read here, which
    /// silently over-read into the next pipelined request on a keep-alive
    /// connection. See PILOT-182 review #5 finding "MUST FIX".
    async fn read_line<R>(
        client: &mut R,
        buf: &mut Vec<u8>,
        cursor: usize,
        hostname: &str,
    ) -> Result<usize, &'static str>
    where
        R: AsyncRead + Unpin,
    {
        loop {
            if let Some(p) = buf[cursor..].windows(2).position(|w| w == b"\r\n") {
                return Ok(cursor + p + 2);
            }
            // Need more bytes. Read exactly one to preserve the "no over-read"
            // invariant: the next pipelined request's bytes must stay in the
            // kernel socket buffer, not our Vec<u8>.
            if buf.len() > MAX_PROXY_BODY {
                debug!("chunked control line too long for {hostname}");
                return Err("chunked control line too long");
            }
            match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read_u8()).await {
                Ok(Ok(b)) => buf.push(b),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Err("client closed mid-chunked-control-line");
                }
                Ok(Err(_)) => return Err("read error mid-chunked-control-line"),
                Err(_) => return Err("chunked control line read timed out"),
            }
        }
    }

    loop {
        // Read the chunk-size line.
        let line_end = read_line(client, buf, cursor, hostname).await?;
        let size_line = &buf[cursor..line_end - 2]; // exclude trailing CRLF
        let size_str = std::str::from_utf8(size_line).map_err(|_| "non-utf8 chunk size")?;
        // Discard chunk-extensions (anything after ';').
        let size_str = size_str.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(size_str, 16).map_err(|_| "invalid chunk size")?;
        cursor = line_end;

        if chunk_size == 0 {
            // Last chunk. Read trailers (zero or more header lines), each
            // terminated by CRLF, ending with an empty CRLF.
            loop {
                let trailer_end = read_line(client, buf, cursor, hostname).await?;
                if trailer_end == cursor + 2 {
                    // Empty line — end of trailers, end of chunked body.
                    cursor = trailer_end;
                    break;
                }
                cursor = trailer_end;
            }
            // Truncate any over-read tail that the caller's header-phase
            // read pulled off the wire past `cursor`. The outer header
            // reader uses an 8 KB buffered read, so when headers are
            // found in the initial read, `buf` may contain bytes past the
            // `\r\n\r\n` terminator — for a chunked request, those bytes
            // are either part of the chunked body (consumed above as
            // cursor advances) or part of a subsequent pipelined request
            // (rare in Pilot's mobile-test use case — ordinary URLSession /
            // fetch / axios clients don't pipeline chunked uploads).
            //
            // After this truncate, `req.raw_bytes` written upstream
            // contains exactly the first request's bytes, with no garbage
            // tail. Any pipelined next-request bytes are dropped
            // (documented limitation) rather than leaked upstream.
            buf.truncate(cursor);
            return Ok(());
        }

        // Read `chunk_size` data bytes + the trailing CRLF, using checked
        // arithmetic to reject attacker-supplied `chunk_size == usize::MAX`
        // from wrapping. (PILOT-182 review #5 finding SF2.)
        let need_until = cursor
            .checked_add(chunk_size)
            .and_then(|v| v.checked_add(2))
            .ok_or("chunk size overflow")?;
        ensure_at_least(client, buf, need_until, hostname).await?;
        // Sanity-check the trailing CRLF is actually CRLF.
        if &buf[need_until - 2..need_until] != b"\r\n" {
            return Err("chunk data not terminated by CRLF");
        }
        cursor = need_until;
    }
}

/// Post-header body-framing state for a response-in-progress read. Set once
/// when the header terminator is first seen, then used to decide completion
/// on subsequent reads in O(1) for fixed-length bodies (the common case).
enum BodyFraming {
    /// Content-Length body; read until `buf.len() >= total_needed`.
    FixedLength { total_needed: usize },
    /// Transfer-Encoding: chunked; read until the terminator is observed.
    Chunked {
        header_end: usize,
        chunked_scan_cursor: usize,
    },
    /// 1xx / 204 / 304 — no body expected.
    NoBody,
    /// No Content-Length and not chunked — read until upstream closes (EOF
    /// from the read loop handles this; no completion check needed).
    UntilClose,
}

/// Read a full HTTP/1.x response from an upstream stream. Parses the header
/// terminator + framing exactly once (when headers are first complete),
/// then checks completion on each subsequent read in O(1) for Content-Length
/// responses. Chunked responses still scan a growing-cursor window each
/// read, but never re-scan already-searched bytes.
async fn read_response<R>(upstream: &mut R, hostname: &str) -> ReadOutcome<ParsedResponse>
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 8192];
    let mut scan_cursor = 0usize;
    // Set once the header terminator is seen.
    let mut framing: Option<BodyFraming> = None;
    // Cached header_end for building ParsedResponse at the end.
    let mut cached_header_end: usize = 0;
    // Cached parsed headers (set alongside framing).
    let mut cached_headers: Vec<(String, String)> = Vec::new();
    let mut cached_status: i32 = 0;

    loop {
        match tokio::time::timeout(UPSTREAM_READ_TIMEOUT, upstream.read(&mut tmp)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&tmp[..n]);

                // Phase A: still looking for the header terminator.
                if framing.is_none() {
                    if let Some(header_end) = find_header_terminator(&buf, scan_cursor) {
                        cached_header_end = header_end;
                        let (headers, _) = parse_headers(&buf[..header_end]);
                        let status = parse_status_code(&buf);
                        cached_status = status;

                        let is_chunked = is_chunked_transfer_encoding(&headers);
                        let content_length: Option<usize> = headers
                            .iter()
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, v)| v.trim().parse::<usize>().ok());

                        // RFC 7230 §3.3.3: reject responses with both framing
                        // headers — smuggling vector the same way as requests.
                        // (PILOT-182 review #5 finding SF1.)
                        if is_chunked && content_length.is_some() {
                            debug!(
                                "MITM rejecting response with both Transfer-Encoding \
                                 and Content-Length for {hostname} (RFC 7230 §3.3.3)"
                            );
                            return ReadOutcome::Error;
                        }

                        cached_headers = headers;

                        framing = Some(if matches!(status, 100..=199 | 204 | 304) {
                            BodyFraming::NoBody
                        } else if is_chunked {
                            BodyFraming::Chunked {
                                header_end,
                                chunked_scan_cursor: header_end,
                            }
                        } else if let Some(cl) = content_length {
                            // Reject oversized declared bodies up-front rather
                            // than truncating — silent truncation desyncs the
                            // connection (PILOT-182 review #4 finding S1).
                            if cl > MAX_PROXY_BODY {
                                debug!(
                                    "MITM rejecting response with oversized Content-Length \
                                     for {hostname}: {cl} > {MAX_PROXY_BODY}"
                                );
                                return ReadOutcome::Error;
                            }
                            BodyFraming::FixedLength {
                                total_needed: header_end.saturating_add(cl),
                            }
                        } else {
                            BodyFraming::UntilClose
                        });
                    } else {
                        scan_cursor = buf.len();
                    }
                }

                // Phase B: check completion based on cached framing. O(1) for
                // fixed-length; cursor-windowed scan for chunked; never for
                // UntilClose (which terminates on upstream EOF = Ok(0) above).
                let complete = match framing.as_mut() {
                    None => false,
                    Some(BodyFraming::NoBody) => true,
                    Some(BodyFraming::FixedLength { total_needed }) => buf.len() >= *total_needed,
                    Some(BodyFraming::Chunked {
                        header_end,
                        chunked_scan_cursor,
                    }) => {
                        let he = *header_end;
                        let start = (*chunked_scan_cursor).saturating_sub(4).max(he);
                        // TODO(PILOT-186): replace this heuristic with the
                        // strict chunked parser already used on the request
                        // side (`read_chunked_body`). The scan below can
                        // false-positive on binary bodies that contain the
                        // literal bytes `\r\n0\r\n` followed by `\r\n\r\n` —
                        // rare in practice for JSON/HTML/compressed content,
                        // but a correctness hazard worth fixing.
                        //
                        // Chunked terminator is a `0\r\n` final-size chunk
                        // followed by zero or more trailers and a final
                        // `\r\n`. The `0\r\n` marker can appear either at the
                        // start of the body (an empty-body chunked response
                        // such as a 200 to a HEAD-ish poll endpoint) OR
                        // preceded by the final `\r\n` of the previous data
                        // chunk (the common case). The `starts_with` check
                        // is load-bearing — `windows(5)` on `b"\r\n0\r\n"`
                        // alone misses the empty-body case because there's
                        // no leading `\r\n` before the `0`.
                        let body = &buf[he..];
                        let has_zero_chunk = body.starts_with(b"0\r\n")
                            || buf[start..].windows(5).any(|w| w == b"\r\n0\r\n");
                        let done = has_zero_chunk && buf.ends_with(b"\r\n\r\n");
                        *chunked_scan_cursor = buf.len();
                        done
                    }
                    Some(BodyFraming::UntilClose) => false,
                };
                if complete {
                    break;
                }
                // Reject oversized responses rather than breaking out with
                // a truncated buffer. Returning `Ok` with partial data would
                // write a short message to the client and leave the upstream
                // connection holding unread bytes — the next `read_response`
                // iteration would then read those bytes as if they were a
                // new response header, desyncing the keep-alive connection
                // and corrupting the trace. Parallel to `read_request`'s
                // oversized-Content-Length reject (PILOT-182 review #4 S1).
                if buf.len() > MAX_PROXY_BODY {
                    debug!(
                        "MITM response body exceeded MAX_PROXY_BODY for {hostname} \
                         ({} bytes) — closing upstream",
                        buf.len()
                    );
                    return ReadOutcome::Error;
                }
            }
            Ok(Err(e)) => {
                debug!("MITM read from upstream for {hostname}: {e}");
                break;
            }
            Err(_) => {
                debug!("MITM read from upstream timed out for {hostname}");
                break;
            }
        }
    }

    if buf.is_empty() {
        return ReadOutcome::ConnectionClosed;
    }

    // If framing was never set (loop ended before the header terminator
    // arrived — e.g. upstream closed mid-header), fall back to a one-shot
    // full-buffer parse.
    let (headers, header_end, status_code) = if framing.is_some() {
        (cached_headers, cached_header_end, cached_status)
    } else {
        let (h, he) = parse_headers(&buf);
        let s = parse_status_code(&buf);
        (h, he, s)
    };

    let body = if header_end < buf.len() {
        buf[header_end..].to_vec()
    } else {
        Vec::new()
    };

    ReadOutcome::Ok(ParsedResponse {
        status_code,
        headers,
        body,
        raw_bytes: buf,
    })
}

/// RFC 7230 token char check for HTTP header names. Used to defend against
/// header-injection smuggling when re-encoding requests/responses after a
/// `NetworkHandler` hook has mutated them.
fn is_valid_header_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.bytes().all(|b| {
        matches!(b,
            b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
            | b'^' | b'_' | b'`' | b'|' | b'~'
            | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z'
        )
    })
}

/// Append a header to the wire-format buffer with injection-safe sanitisation.
///
/// Headers with names containing non-token characters are dropped (logged at
/// debug level). CR and LF in values are replaced with a single space, which
/// preserves the value's visible content while preventing a malicious handler
/// from smuggling additional headers or a second request via embedded
/// `\r\n` sequences.
fn write_header_sanitised(out: &mut Vec<u8>, name: &str, value: &str) {
    if !is_valid_header_name(name) {
        debug!(name = %name, "dropping header with invalid name characters");
        return;
    }
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(b": ");
    for &b in value.as_bytes() {
        if b == b'\r' || b == b'\n' {
            out.push(b' ');
        } else {
            out.push(b);
        }
    }
    out.extend_from_slice(b"\r\n");
}

/// Replace CR/LF bytes in a request-line component (method or path) with a
/// single space. Defends `reencode_request` against handler-injected
/// `\r\n` sequences in those fields.
fn sanitise_request_line_component(s: &str) -> Vec<u8> {
    s.bytes()
        .map(|b| if b == b'\r' || b == b'\n' { b' ' } else { b })
        .collect()
}

/// Re-serialize a [`ParsedRequest`] back to HTTP/1.1 wire format. Called
/// after a `NetworkHandler::on_request` hook mutates `method` / `path` /
/// `headers` / `body`, so that the `raw_bytes` forwarded upstream stays in
/// sync with the structured fields. The no-handler hot path never calls
/// this — the original upstream bytes are forwarded verbatim.
///
/// All structured fields are sanitised against HTTP request smuggling: CR/LF
/// in `method`, `path`, and header values are replaced with spaces, and
/// headers with invalid names are dropped. This means a misbehaving handler
/// cannot use this re-encoder as a smuggling vector.
fn reencode_request(req: &ParsedRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(req.raw_bytes.len().max(256));
    out.extend_from_slice(&sanitise_request_line_component(&req.method));
    out.push(b' ');
    out.extend_from_slice(&sanitise_request_line_component(&req.path));
    out.extend_from_slice(b" HTTP/1.1\r\n");
    for (k, v) in &req.headers {
        write_header_sanitised(&mut out, k, v);
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&req.body);
    out
}

/// Re-serialize a [`ParsedResponse`] back to HTTP/1.1 wire format. Called
/// after a `NetworkHandler::on_response` hook mutates `status_code` /
/// `headers` / `body`, or when a handler returns a synthetic response that
/// left `raw_bytes` empty, so the bytes written back to the client stay in
/// sync with the structured fields.
///
/// Headers are sanitised the same way as in [`reencode_request`] — see
/// [`write_header_sanitised`].
fn reencode_response(resp: &ParsedResponse) -> Vec<u8> {
    let reason = match resp.status_code {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let mut out = Vec::with_capacity(resp.raw_bytes.len().max(256));
    out.extend_from_slice(format!("HTTP/1.1 {} {reason}\r\n", resp.status_code).as_bytes());
    for (k, v) in &resp.headers {
        write_header_sanitised(&mut out, k, v);
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&resp.body);
    out
}

/// Push a [`CapturedEntry`] into the shared state, truncating bodies to
/// `MAX_BODY_SIZE`. Does not consume the parsed structs.
async fn record_entry(
    state: &Arc<Mutex<ProxyState>>,
    req: &ParsedRequest,
    resp: &ParsedResponse,
    hostname: &str,
    is_https: bool,
    start_ms: u64,
) {
    let scheme = if is_https { "https" } else { "http" };
    let url = format!("{scheme}://{hostname}{}", req.path);
    let content_type = get_header(&resp.headers, "content-type")
        .unwrap_or_default()
        .to_string();
    let duration = now_ms() - start_ms;

    debug!(
        method = req.method.as_str(),
        url = url.as_str(),
        status_code = resp.status_code,
        duration_ms = duration,
        "HTTP request captured (MITM)"
    );

    let truncate = |b: &[u8]| -> Vec<u8> {
        if b.len() > MAX_BODY_SIZE {
            b[..MAX_BODY_SIZE].to_vec()
        } else {
            b.to_vec()
        }
    };

    state.lock().await.entries.push(CapturedEntry {
        method: req.method.clone(),
        url,
        status_code: resp.status_code,
        content_type,
        request_size: req.body.len() as u64,
        response_size: resp.body.len() as u64,
        start_time_ms: start_ms,
        duration_ms: duration,
        request_headers: req.headers.clone(),
        response_headers: resp.headers.clone(),
        request_body: truncate(&req.body),
        response_body: truncate(&resp.body),
        is_https,
    });
}

/// Proxy decrypted HTTP traffic between client and upstream streams,
/// capturing each request/response pair. Handles HTTP/1.1 keep-alive by
/// looping until the connection closes.
///
/// The `is_https` flag only affects the captured URL scheme and the
/// `CapturedEntry::is_https` field — both TLS (post-handshake) and plain-TCP
/// streams are handled identically inside the loop. This is what lets the
/// same function serve the Android CONNECT-tunnel path (post TLS handshake,
/// `is_https = true`) and the iOS transparent-TCP path (peek decides, either
/// branch).
async fn handle_mitm_http<C, U>(
    mut client_stream: C,
    mut upstream_stream: U,
    hostname: &str,
    state: Arc<Mutex<ProxyState>>,
    is_https: bool,
) where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    // Snapshot the handler once per connection. A handler is configured
    // before capture starts and doesn't change during a live connection, so
    // there's no need to re-lock on every request iteration. Today this is
    // always None and the hook call-sites below are no-ops at runtime,
    // but the full hook plumbing (including `raw_bytes` regeneration after
    // mutation) is in place so the future modification feature drops in
    // cleanly — a handler that mutates `req.headers`/`req.body` is actually
    // observed on the wire, not silently dropped.
    let handler = state.lock().await.handler.clone();

    loop {
        let start = now_ms();

        let mut req = match read_request(&mut client_stream, hostname).await {
            ReadOutcome::Ok(r) => r,
            ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
        };

        // Request hook: optionally transform the request, and optionally
        // short-circuit with a synthetic response (no upstream call at all).
        // After the hook runs we re-serialize `raw_bytes` from the (possibly
        // mutated) structured fields so the upstream write below sees the
        // new shape. The synthetic-response branch never forwards upstream,
        // so we skip the re-encode there — it's wasted work (`record_entry`
        // reads structured fields, not `raw_bytes`).
        if let Some(h) = handler.as_ref() {
            if let Some(mut synth) = h.on_request(&mut req).await {
                if synth.raw_bytes.is_empty() {
                    synth.raw_bytes = reencode_response(&synth);
                }
                if client_stream.write_all(&synth.raw_bytes).await.is_err() {
                    return;
                }
                let close = has_connection_close(&synth.headers);
                record_entry(&state, &req, &synth, hostname, is_https, start).await;
                if close {
                    return;
                }
                continue;
            }
            // Non-synthetic path: the handler may have mutated `req`, so
            // reserialize before forwarding upstream.
            req.raw_bytes = reencode_request(&req);
        }

        if upstream_stream.write_all(&req.raw_bytes).await.is_err() {
            return;
        }

        let mut resp = match read_response(&mut upstream_stream, hostname).await {
            ReadOutcome::Ok(r) => r,
            ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
        };

        // Response hook: optionally transform the response before forwarding.
        // Same `raw_bytes` regeneration rule — keep wire bytes in sync with
        // the structured fields after any mutation.
        if let Some(h) = handler.as_ref() {
            h.on_response(&req, &mut resp).await;
            resp.raw_bytes = reencode_response(&resp);
        }

        if client_stream.write_all(&resp.raw_bytes).await.is_err() {
            return;
        }

        // Extract keep-alive hint BEFORE recording so we can consume `resp`
        // via borrow rather than move. Matches original semantics: only
        // response's Connection: close is honored, request's is ignored.
        let connection_close = has_connection_close(&resp.headers);

        record_entry(&state, &req, &resp, hostname, is_https, start).await;

        if connection_close {
            return;
        }
    }
}

/// Check if a raw HTTP response buffer contains a complete response.
///
/// Handles both Content-Length and chunked transfer encoding. Returns `true`
/// if we've received enough data to constitute a full response.
///
/// This is called in a tight read loop, so it scans raw bytes directly
/// rather than invoking `parse_headers` on every call.
fn response_complete(buf: &[u8]) -> bool {
    let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(pos) => pos + 4,
        None => return false, // haven't received all headers yet
    };

    // Scan header bytes for Transfer-Encoding and Content-Length without
    // allocating a full header Vec on every call.
    let header_bytes = &buf[..header_end];
    let header_str = String::from_utf8_lossy(header_bytes);
    let header_lower = header_str.to_lowercase();

    // Check for chunked transfer encoding (strict token matching — see
    // [`is_chunked_transfer_encoding`] for the precise-match rationale).
    let is_chunked = header_lower.lines().any(|line| {
        line.strip_prefix("transfer-encoding:").is_some_and(|rest| {
            rest.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("chunked"))
        })
    });

    if is_chunked {
        // Chunked terminator: "0\r\n" final chunk + optional trailers + "\r\n\r\n".
        // The buffer must end with \r\n\r\n (end of trailer section).
        if !buf.ends_with(b"\r\n\r\n") {
            return false;
        }
        // Find the last-chunk marker "0\r\n" after a CRLF (or at body start).
        let body = &buf[header_end..];
        // Search for "\r\n0\r\n" in the body, or "0\r\n" at the very start of the body.
        if body.starts_with(b"0\r\n") {
            return true;
        }
        return body.windows(5).any(|w| w == b"\r\n0\r\n");
    }

    // Check Content-Length
    for line in header_lower.lines() {
        if let Some(rest) = line.strip_prefix("content-length:") {
            if let Ok(content_length) = rest.trim().parse::<usize>() {
                return buf.len() >= header_end + content_length;
            }
        }
    }

    // No Content-Length and not chunked — assume we need to read until close.
    // For keep-alive connections with no body indicators, the response is
    // just the headers (e.g., 204 No Content, 304 Not Modified).
    let status_code = parse_status_code(buf);

    // Responses with no body
    matches!(status_code, 204 | 304 | 100..=199)
}

/// Handle a plain HTTP request (forward proxy).
async fn handle_http(
    mut client: TcpStream,
    method: &str,
    target_url: &str,
    initial_data: &[u8],
    state: Arc<Mutex<ProxyState>>,
) {
    let start = now_ms();

    // Parse the target host from the URL
    let (host, path) = match parse_http_url(target_url) {
        Some(h) => h,
        None => {
            debug!("Cannot parse URL: {target_url}");
            let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            return;
        }
    };

    // Parse request headers from initial data
    let (req_headers, header_end) = parse_headers(initial_data);
    let mut request_body = if header_end < initial_data.len() {
        initial_data[header_end..].to_vec()
    } else {
        Vec::new()
    };

    // Read remaining request body if Content-Length indicates more data
    let content_length: usize = get_header(&req_headers, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_PROXY_BODY);
    let body_so_far = request_body.len();
    if content_length > body_so_far {
        let remaining = content_length - body_so_far;
        let mut body_buf = vec![0u8; remaining];
        if let Err(e) = client.read_exact(&mut body_buf).await {
            debug!("Reading HTTP request body: {e}");
            return;
        }
        request_body.extend_from_slice(&body_buf);
    }

    // Rebuild the request with a relative path for the upstream server
    let mut upstream_request = format!("{method} {path} HTTP/1.1\r\n");
    let mut has_connection = false;
    for (key, value) in &req_headers {
        let lower = key.to_lowercase();
        // Skip proxy-specific headers
        if lower == "proxy-connection" {
            continue;
        }
        // Force Connection: close to simplify response reading
        if lower == "connection" {
            has_connection = true;
            upstream_request.push_str("Connection: close\r\n");
            continue;
        }
        upstream_request.push_str(&format!("{key}: {value}\r\n"));
    }
    if !has_connection {
        upstream_request.push_str("Connection: close\r\n");
    }
    upstream_request.push_str("\r\n");

    // Connect to upstream
    let connect_target = if host.contains(':') {
        host.clone()
    } else {
        format!("{host}:80")
    };

    let connect_result = tokio::time::timeout(
        UPSTREAM_CONNECT_TIMEOUT,
        TcpStream::connect(&connect_target),
    )
    .await
    .unwrap_or_else(|_| {
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "connect timed out",
        ))
    });

    let mut upstream = match connect_result {
        Ok(s) => s,
        Err(e) => {
            debug!("Failed to connect to {connect_target}: {e}");
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
            state.lock().await.entries.push(CapturedEntry {
                method: method.to_string(),
                url: target_url.to_string(),
                status_code: 502,
                content_type: String::new(),
                request_size: initial_data.len() as u64,
                response_size: 0,
                start_time_ms: start,
                duration_ms: now_ms() - start,
                request_headers: req_headers,
                response_headers: Vec::new(),
                request_body,
                response_body: Vec::new(),
                is_https: false,
            });
            return;
        }
    };

    // Send request to upstream
    if upstream
        .write_all(upstream_request.as_bytes())
        .await
        .is_err()
    {
        return;
    }
    if !request_body.is_empty() && upstream.write_all(&request_body).await.is_err() {
        return;
    }

    // Read response until complete (Content-Length or chunked, with per-read timeout)
    let mut response_data = Vec::new();
    let mut buf = vec![0u8; 8192];
    loop {
        match tokio::time::timeout(UPSTREAM_READ_TIMEOUT, upstream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                response_data.extend_from_slice(&buf[..n]);
                if response_complete(&response_data) {
                    break;
                }
                if response_data.len() > MAX_PROXY_BODY {
                    break;
                }
            }
            Ok(Err(_)) | Err(_) => break,
        }
    }

    // Parse response status and headers
    let status_code = parse_status_code(&response_data);
    let (resp_headers, resp_header_end) = parse_headers(&response_data);
    let content_type = get_header(&resp_headers, "content-type")
        .unwrap_or_default()
        .to_string();
    let response_body = if resp_header_end < response_data.len() {
        response_data[resp_header_end..].to_vec()
    } else {
        Vec::new()
    };

    // Forward response to client
    let _ = client.write_all(&response_data).await;

    let duration = now_ms() - start;
    debug!(
        method,
        url = target_url,
        status_code,
        duration_ms = duration,
        "HTTP request captured"
    );

    // Truncate bodies to 1MB max
    let max_body = MAX_BODY_SIZE;
    state.lock().await.entries.push(CapturedEntry {
        method: method.to_string(),
        url: target_url.to_string(),
        status_code,
        content_type,
        request_size: request_body.len() as u64,
        response_size: response_body.len() as u64,
        start_time_ms: start,
        duration_ms: duration,
        request_headers: req_headers,
        response_headers: resp_headers,
        request_body: if request_body.len() > max_body {
            request_body[..max_body].to_vec()
        } else {
            request_body
        },
        response_body: if response_body.len() > max_body {
            response_body[..max_body].to_vec()
        } else {
            response_body
        },
        is_https: false,
    });
}

// ─── Transparent-TCP entry point (iOS Network Extension redirect) ───
//
// Used by the `ios_redirect` module to feed already-accepted client streams
// into the MITM pipeline without a CONNECT preamble. The transparent-TCP
// path is macOS-only because its only consumer (the iOS NE redirector) is
// macOS-only; keeping the cfg gate avoids dead-code warnings on Linux.

/// A stream adapter that reads from a pre-captured prefix buffer first,
/// then delegates to an inner stream. Used by [`handle_transparent_tcp`] to
/// "un-peek" the first bytes read during TLS/HTTP detection.
#[cfg(target_os = "macos")]
struct PrefixedStream<S> {
    prefix: Vec<u8>,
    prefix_pos: usize,
    inner: S,
}

#[cfg(target_os = "macos")]
impl<S> PrefixedStream<S> {
    fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            prefix_pos: 0,
            inner,
        }
    }
}

#[cfg(target_os = "macos")]
impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.prefix_pos < self.prefix.len() {
            let remaining = &self.prefix[self.prefix_pos..];
            let n = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..n]);
            self.prefix_pos += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

#[cfg(target_os = "macos")]
impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Dial a TCP upstream with the shared connect timeout, logging on failure.
#[cfg(target_os = "macos")]
async fn dial_upstream(dst_host: &str, dst_port: u16) -> Option<TcpStream> {
    let addr = format!("{dst_host}:{dst_port}");
    match tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
        Ok(Ok(s)) => Some(s),
        Ok(Err(e)) => {
            debug!("transparent-TCP failed to connect upstream {addr}: {e}");
            None
        }
        Err(_) => {
            debug!("transparent-TCP timeout connecting upstream {addr}");
            None
        }
    }
}

/// Handle a transparent-TCP client stream from the iOS Network Extension
/// redirector (or any other per-process redirect mechanism that produces an
/// already-accepted, already-routed client stream).
///
/// Unlike [`handle_connect`], there's no `CONNECT host:port` preamble — the
/// destination is known out-of-band (from the redirector's `NewFlow`). But
/// the macOS Network Extension reports the **resolved IP** as `dst_host`,
/// not the hostname the client was originally fetching. Using the IP as
/// SNI would break TLS handshakes with name-based virtual-host servers
/// (Cloudflare, Fastly, CDN-hosted APIs, ...) — they'd either reject the
/// connection with HandshakeFailure or return a cert for a different name.
///
/// So we peek the first 3 bytes of the client stream. A TLS record starts
/// with `0x16 0x03 0x0?` (Handshake ContentType + SSL 3.0 / TLS 1.x major
/// version + minor version 0..=4), which can't appear at the start of a
/// valid HTTP request (whose first byte is always an ASCII method letter >
/// `0x40`). If the prefix matches, we run [`tokio_rustls::LazyConfigAcceptor`]
/// to lazily parse the client's `ClientHello`, extract the **real hostname
/// from the SNI extension**, and use that as the upstream `ServerName` +
/// the per-host MITM cert CN. The client handshake is then resumed via
/// [`tokio_rustls::StartHandshake::into_stream`]. Plain HTTP flows pass
/// through to [`handle_mitm_http`] directly (no SNI needed).
#[cfg(target_os = "macos")]
pub(crate) async fn handle_transparent_tcp<S>(
    mut client: S,
    dst_host: String,
    dst_port: u16,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Bounded peek read: a redirected client that opens a TCP connection
    // and then never sends bytes (slow-loris, broken keep-alive probe,
    // background URLSession idle slot) would otherwise park this task
    // forever — and every parked task pins an entry in
    // `IosRedirect::flow_tasks`. The CONNECT-tunnel handlers use
    // CLIENT_READ_TIMEOUT for the same reason; the transparent path
    // must not silently drop it.
    let mut peek = [0u8; 3];
    let peek_res = tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read_exact(&mut peek)).await;
    match peek_res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            debug!(%dst_host, dst_port, "transparent-TCP peek failed: {e}");
            return;
        }
        Err(_) => {
            debug!(%dst_host, dst_port, "transparent-TCP peek timed out");
            return;
        }
    }
    // Validate the full 3-byte TLS record prefix:
    //   peek[0] = 0x16 → TLS ContentType.Handshake
    //   peek[1] = 0x03 → SSL/TLS major version 3
    //   peek[2] ∈ 0..=4 → minor version (SSL 3.0 / TLS 1.0–1.3)
    // Any other prefix is treated as plain HTTP (HTTP method letters are
    // all > 0x40, so this can't collide with a real HTTP/1.x request).
    let is_tls = peek[0] == 0x16 && peek[1] == 0x03 && peek[2] <= 0x04;
    let chained = PrefixedStream::new(peek.to_vec(), client);

    if is_tls {
        handle_transparent_tls(chained, dst_host, dst_port, state, mitm_ca).await;
    } else {
        let Some(upstream_tcp) = dial_upstream(&dst_host, dst_port).await else {
            return;
        };
        handle_mitm_http(
            chained,
            upstream_tcp,
            &dst_host,
            state,
            /* is_https */ false,
        )
        .await;
    }
}

/// Lazily read the client's TLS `ClientHello`, extract SNI, dial upstream
/// with the real hostname as SNI, mint a matching cert, resume the client
/// handshake, and hand both decrypted streams to [`handle_mitm_http`].
#[cfg(target_os = "macos")]
async fn handle_transparent_tls<S>(
    chained: PrefixedStream<S>,
    dst_host: String,
    dst_port: u16,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Bounded ClientHello read for the same reason as the peek above:
    // a client that sends `0x16 0x03 0x01` and then stalls mid-handshake
    // would park this task indefinitely.
    let start = match tokio::time::timeout(
        CLIENT_READ_TIMEOUT,
        tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), chained),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            debug!(%dst_host, dst_port, "failed reading TLS ClientHello: {e}");
            return;
        }
        Err(_) => {
            debug!(%dst_host, dst_port, "timed out reading TLS ClientHello");
            return;
        }
    };

    // Prefer the SNI from the ClientHello — that's the hostname the app
    // actually wanted. Fall back to `dst_host` (likely an IP) if the
    // client didn't send SNI at all (rare; mostly very old TLS clients).
    let sni = start
        .client_hello()
        .server_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| dst_host.clone());
    debug!(
        %dst_host, dst_port, %sni,
        "transparent TLS: extracted SNI from ClientHello"
    );

    let Some(upstream_tcp) = dial_upstream(&dst_host, dst_port).await else {
        return;
    };

    let tls_client_config = state.lock().await.tls_client_config.clone();
    let server_name = match rustls::pki_types::ServerName::try_from(sni.clone()) {
        Ok(sn) => sn,
        Err(e) => {
            debug!("invalid server name '{sni}': {e}");
            return;
        }
    };
    let upstream_tls = match TlsConnector::from(tls_client_config)
        .connect(server_name, upstream_tcp)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            debug!("upstream TLS handshake failed for {sni}: {e}");
            return;
        }
    };

    // Mint a per-host cert signed by our MITM CA and resume the client
    // handshake using the ClientHello bytes the acceptor already read.
    let server_config = match mitm_ca.server_config_for_host(&sni).await {
        Ok(c) => c,
        Err(e) => {
            debug!("cert mint failed for {sni}: {e}");
            return;
        }
    };
    let client_tls = match start.into_stream(server_config).await {
        Ok(s) => s,
        Err(e) => {
            debug!("client TLS handshake failed for {sni}: {e}");
            return;
        }
    };

    handle_mitm_http(
        client_tls,
        upstream_tls,
        &sni,
        state,
        /* is_https */ true,
    )
    .await;
}

/// Parse host and path from an absolute HTTP URL.
fn parse_http_url(url: &str) -> Option<(String, String)> {
    let stripped = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let (host, path) = match stripped.find('/') {
        Some(idx) => (stripped[..idx].to_string(), stripped[idx..].to_string()),
        None => (stripped.to_string(), "/".to_string()),
    };
    Some((host, path))
}

/// Case-insensitive header lookup on a `Vec<(String, String)>`.
/// Returns the first matching value.
fn get_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let lower = name.to_lowercase();
    headers
        .iter()
        .find(|(k, _)| k.to_lowercase() == lower)
        .map(|(_, v)| v.as_str())
}

/// Parse headers from a raw HTTP message bytes. Returns headers list and byte
/// offset of the body start. Headers are stored in order, preserving
/// duplicates (e.g. multiple Set-Cookie headers).
fn parse_headers(raw: &[u8]) -> (Vec<(String, String)>, usize) {
    let mut headers = Vec::new();

    // Find the header/body boundary in the raw bytes
    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| pos + 4)
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|pos| pos + 2))
        .unwrap_or(raw.len());

    // Parse header lines from the header portion only (ASCII-safe)
    let header_bytes = &raw[..header_end];
    let header_str = String::from_utf8_lossy(header_bytes);

    for (i, line) in header_str.lines().enumerate() {
        if i == 0 {
            continue; // skip request/status line
        }
        let clean = line.trim_end_matches('\r');
        if clean.is_empty() {
            break;
        }
        if let Some((key, value)) = clean.split_once(':') {
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
    }

    (headers, header_end)
}

/// Extract the status code from the first line of an HTTP response.
fn parse_status_code(raw: &[u8]) -> i32 {
    let header_end = raw.len().min(256); // status line is always near the start
    let snippet = String::from_utf8_lossy(&raw[..header_end]);
    let first_line = snippet.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() >= 2 {
        parts[1].parse().unwrap_or(0)
    } else {
        0
    }
}

/// Serialize headers as a JSON object. Duplicate header names are joined
/// with ", " per RFC 9110 §5.3, except Set-Cookie which uses "\n" per
/// RFC 6265 (cookies can contain commas so must not be comma-folded).
pub fn headers_to_json_object(headers: &[(String, String)]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (key, value) in headers {
        let lower = key.to_lowercase();
        if let Some(existing) = map.get_mut(&lower) {
            if let serde_json::Value::String(s) = existing {
                // Set-Cookie must not be comma-folded (RFC 6265)
                let separator = if lower == "set-cookie" { "\n" } else { ", " };
                s.push_str(separator);
                s.push_str(value);
            }
        } else {
            map.insert(lower, serde_json::Value::String(value.clone()));
        }
    }
    serde_json::Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_headers_basic() {
        let raw = b"GET / HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/html\r\n\r\nbody";
        let (headers, offset) = parse_headers(raw);
        assert_eq!(headers.len(), 2);
        assert_eq!(get_header(&headers, "Host"), Some("example.com"));
        assert_eq!(get_header(&headers, "content-type"), Some("text/html"));
        assert_eq!(&raw[offset..], b"body");
    }

    #[test]
    fn parse_headers_preserves_duplicates() {
        let raw = b"HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n";
        let (headers, _) = parse_headers(raw);
        let cookies: Vec<&str> = headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("Set-Cookie"))
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(cookies, vec!["a=1", "b=2"]);
    }

    #[test]
    fn get_header_case_insensitive() {
        let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        assert_eq!(
            get_header(&headers, "content-type"),
            Some("application/json")
        );
        assert_eq!(
            get_header(&headers, "CONTENT-TYPE"),
            Some("application/json")
        );
        assert_eq!(
            get_header(&headers, "Content-Type"),
            Some("application/json")
        );
        assert_eq!(get_header(&headers, "x-missing"), None);
    }

    #[test]
    fn parse_status_code_basic() {
        assert_eq!(parse_status_code(b"HTTP/1.1 200 OK\r\n\r\n"), 200);
        assert_eq!(parse_status_code(b"HTTP/1.1 404 Not Found\r\n\r\n"), 404);
        assert_eq!(parse_status_code(b"HTTP/1.1 302 Found\r\n\r\n"), 302);
        assert_eq!(parse_status_code(b"garbage"), 0);
    }

    #[test]
    fn parse_http_url_basic() {
        assert_eq!(
            parse_http_url("http://example.com/path"),
            Some(("example.com".to_string(), "/path".to_string())),
        );
        assert_eq!(
            parse_http_url("http://example.com:8080/path"),
            Some(("example.com:8080".to_string(), "/path".to_string())),
        );
        assert_eq!(
            parse_http_url("http://example.com"),
            Some(("example.com".to_string(), "/".to_string())),
        );
        assert_eq!(
            parse_http_url("https://example.com/secure"),
            Some(("example.com".to_string(), "/secure".to_string())),
        );
        assert_eq!(parse_http_url("ftp://nope"), None);
    }

    #[test]
    fn response_complete_content_length() {
        let resp = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        assert!(response_complete(resp));

        let partial = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel";
        assert!(!response_complete(partial));
    }

    #[test]
    fn response_complete_chunked() {
        let resp = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        assert!(response_complete(resp));

        let partial = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n";
        assert!(!response_complete(partial));
    }

    #[test]
    fn response_complete_chunked_with_trailers() {
        let resp = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nTrailer: value\r\n\r\n";
        assert!(response_complete(resp));
    }

    #[test]
    fn response_complete_no_body() {
        let resp = b"HTTP/1.1 204 No Content\r\n\r\n";
        assert!(response_complete(resp));

        let resp = b"HTTP/1.1 304 Not Modified\r\n\r\n";
        assert!(response_complete(resp));
    }

    #[test]
    fn response_complete_headers_not_done() {
        let partial = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n";
        assert!(!response_complete(partial));
    }

    #[test]
    fn headers_to_json_merges_duplicates() {
        let headers = vec![
            ("X-Custom".to_string(), "a".to_string()),
            ("X-Custom".to_string(), "b".to_string()),
            ("Content-Type".to_string(), "text/html".to_string()),
        ];
        let json = headers_to_json_object(&headers);
        assert_eq!(json["x-custom"], "a, b");
        assert_eq!(json["content-type"], "text/html");
    }

    #[test]
    fn headers_to_json_set_cookie_uses_newline_separator() {
        let headers = vec![
            ("Set-Cookie".to_string(), "a=1; Path=/".to_string()),
            ("Set-Cookie".to_string(), "b=2; HttpOnly".to_string()),
        ];
        let json = headers_to_json_object(&headers);
        assert_eq!(json["set-cookie"], "a=1; Path=/\nb=2; HttpOnly");
    }

    #[test]
    fn parse_headers_body_offset_correct_with_body() {
        let raw = b"POST /api HTTP/1.1\r\nContent-Length: 13\r\n\r\n{\"key\":\"val\"}";
        let (_, offset) = parse_headers(raw);
        assert_eq!(&raw[offset..], b"{\"key\":\"val\"}");
    }

    #[test]
    fn find_header_terminator_detects_basic_case() {
        let buf = b"GET / HTTP/1.1\r\nHost: a\r\n\r\nbody";
        assert_eq!(find_header_terminator(buf, 0), Some(27));
    }

    #[test]
    fn find_header_terminator_handles_3_byte_overlap() {
        // The first read ends with "\r\n\r" and the second read delivers
        // the final "\n" — the scan cursor must overlap 3 bytes back to
        // catch the terminator across the read boundary.
        let first_read_end = b"GET / HTTP/1.1\r\nHost: a\r\n\r";
        assert_eq!(find_header_terminator(first_read_end, 0), None);

        let mut buf = first_read_end.to_vec();
        let prev_len = buf.len();
        buf.extend_from_slice(b"\n");
        // Scan cursor is prev_len; with the 3-byte overlap the function
        // should still find the terminator that straddles the boundary.
        assert_eq!(find_header_terminator(&buf, prev_len), Some(buf.len()));
    }

    // ─── read_response: round-trip tests via tokio::io::duplex ───

    async fn read_response_once(upstream_bytes: &[u8]) -> ParsedResponse {
        use tokio::io::AsyncWriteExt;
        let (mut client_side, server_side) = tokio::io::duplex(8192);
        client_side.write_all(upstream_bytes).await.unwrap();
        client_side.shutdown().await.unwrap();
        drop(client_side); // signal EOF to reader
        let mut server = server_side;
        match read_response(&mut server, "example.com").await {
            ReadOutcome::Ok(resp) => resp,
            ReadOutcome::ConnectionClosed => panic!("unexpected ConnectionClosed"),
            ReadOutcome::Error => panic!("unexpected Error"),
        }
    }

    #[tokio::test]
    async fn read_response_chunked_with_body() {
        let wire = b"HTTP/1.1 200 OK\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     5\r\nhello\r\n\
                     0\r\n\r\n";
        let resp = read_response_once(wire).await;
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"5\r\nhello\r\n0\r\n\r\n");
    }

    #[tokio::test]
    async fn read_response_chunked_empty_body() {
        // Regression: the rewritten BodyFraming::Chunked check used to
        // require a leading `\r\n` before the `0\r\n` terminator, which
        // broke empty-body chunked responses (the terminator starts at
        // body offset 0 with no prior chunk). Fixed by also testing
        // body.starts_with(b"0\r\n").
        let wire = b"HTTP/1.1 200 OK\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     0\r\n\r\n";
        let resp = read_response_once(wire).await;
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"0\r\n\r\n");
    }

    #[tokio::test]
    async fn read_response_content_length_body() {
        let wire = b"HTTP/1.1 200 OK\r\n\
                     Content-Length: 5\r\n\
                     \r\n\
                     hello";
        let resp = read_response_once(wire).await;
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"hello");
    }

    #[tokio::test]
    async fn read_response_no_body_204() {
        let wire = b"HTTP/1.1 204 No Content\r\n\r\n";
        let resp = read_response_once(wire).await;
        assert_eq!(resp.status_code, 204);
        assert!(resp.body.is_empty());
    }

    // ─── Header injection hardening (reencode_*) ───

    #[test]
    fn is_valid_header_name_accepts_token_chars() {
        assert!(is_valid_header_name("Content-Type"));
        assert!(is_valid_header_name("X-Custom-Header"));
        assert!(is_valid_header_name("Set-Cookie"));
        assert!(is_valid_header_name("a"));
        assert!(is_valid_header_name("X-!#$%&'*+-.^_`|~0123"));
    }

    #[test]
    fn is_valid_header_name_rejects_invalid_chars() {
        assert!(!is_valid_header_name(""));
        assert!(!is_valid_header_name("X-Bad Header")); // space
        assert!(!is_valid_header_name("X-Bad\r\nHeader")); // CR/LF
        assert!(!is_valid_header_name("X:Bad")); // colon
        assert!(!is_valid_header_name("X-(Bad)")); // parens
        assert!(!is_valid_header_name("X-{Bad}")); // braces
    }

    #[test]
    fn write_header_sanitised_replaces_crlf_in_value() {
        let mut out = Vec::new();
        write_header_sanitised(&mut out, "X-Smuggled", "value\r\nInjected: header");
        let written = String::from_utf8(out).unwrap();
        assert_eq!(written, "X-Smuggled: value  Injected: header\r\n");
        assert!(!written.contains("\r\nInjected"));
    }

    #[test]
    fn write_header_sanitised_drops_invalid_name() {
        let mut out = Vec::new();
        write_header_sanitised(&mut out, "Bad Name", "value");
        assert!(out.is_empty());

        let mut out = Vec::new();
        write_header_sanitised(&mut out, "X-Bad\r\n", "value");
        assert!(out.is_empty());
    }

    #[test]
    fn reencode_request_resists_header_value_smuggling() {
        let req = ParsedRequest {
            method: "GET".to_string(),
            path: "/".to_string(),
            headers: vec![(
                "X-Custom".to_string(),
                "ok\r\nX-Injected: smuggled\r\nContent-Length: 0".to_string(),
            )],
            body: vec![],
            raw_bytes: vec![],
        };
        let out = reencode_request(&req);
        // parse_headers skips line 0 (the request line) and parses the rest.
        // A successful smuggling attempt would have produced two headers
        // (X-Custom + X-Injected), or three (+ Content-Length).
        let (headers, _) = parse_headers(&out);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, "X-Custom");
        // CR/LF collapsed to spaces inside the value.
        assert_eq!(headers[0].1, "ok  X-Injected: smuggled  Content-Length: 0");
    }

    #[test]
    fn reencode_request_drops_header_with_invalid_name() {
        let req = ParsedRequest {
            method: "GET".to_string(),
            path: "/".to_string(),
            headers: vec![
                ("X-Good".to_string(), "fine".to_string()),
                ("Bad Name".to_string(), "value".to_string()),
                ("X-Bad\r\nX-Injected".to_string(), "value".to_string()),
            ],
            body: vec![],
            raw_bytes: vec![],
        };
        let out = reencode_request(&req);
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("X-Good: fine\r\n"));
        assert!(!s.contains("Bad Name"));
        assert!(!s.contains("X-Injected"));
    }

    #[test]
    fn reencode_request_sanitises_method_and_path_crlf() {
        let req = ParsedRequest {
            method: "GET\r\nX-Injected: yes".to_string(),
            path: "/foo\r\nX-Path-Injected: yes".to_string(),
            headers: vec![],
            body: vec![],
            raw_bytes: vec![],
        };
        let out = reencode_request(&req);
        // The request line must be a single line — the first \r\n in the
        // output is the request-line terminator.
        let request_line_end = out.windows(2).position(|w| w == b"\r\n").unwrap();
        let request_line = std::str::from_utf8(&out[..request_line_end]).unwrap();
        // CR/LF in method and path collapsed to spaces, no header breaks.
        assert!(request_line.starts_with("GET  X-Injected: yes /foo  X-Path-Injected: yes "));
        assert!(request_line.ends_with("HTTP/1.1"));
        // parse_headers skips line 0 (the request line) — what's left must
        // contain no headers, because the smuggled lines are folded into
        // line 0 by the sanitiser.
        let (headers, _) = parse_headers(&out);
        assert_eq!(headers.len(), 0);
    }

    #[test]
    fn reencode_response_resists_header_value_smuggling() {
        let resp = ParsedResponse {
            status_code: 200,
            headers: vec![(
                "X-Custom".to_string(),
                "ok\r\nX-Injected: smuggled".to_string(),
            )],
            body: vec![],
            raw_bytes: vec![],
        };
        let out = reencode_response(&resp);
        // parse_headers skips line 0 (the status line) and parses the rest.
        // A successful smuggling attempt would have produced two headers.
        let (headers, _) = parse_headers(&out);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, "X-Custom");
        assert_eq!(headers[0].1, "ok  X-Injected: smuggled");
    }

    #[test]
    fn reencode_response_drops_header_with_invalid_name() {
        let resp = ParsedResponse {
            status_code: 200,
            headers: vec![
                ("Content-Type".to_string(), "text/plain".to_string()),
                ("Bad Name".to_string(), "value".to_string()),
            ],
            body: vec![],
            raw_bytes: vec![],
        };
        let out = reencode_response(&resp);
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("Content-Type: text/plain\r\n"));
        assert!(!s.contains("Bad Name"));
    }

    // ─── read_request: round-trip tests via tokio::io::duplex ───

    async fn read_request_outcome(client_bytes: &[u8]) -> ReadOutcome<ParsedRequest> {
        use tokio::io::AsyncWriteExt;
        let (mut client_side, server_side) = tokio::io::duplex(65536);
        client_side.write_all(client_bytes).await.unwrap();
        client_side.shutdown().await.unwrap();
        drop(client_side);
        let mut server = server_side;
        read_request(&mut server, "example.com").await
    }

    async fn read_request_once(client_bytes: &[u8]) -> ParsedRequest {
        match read_request_outcome(client_bytes).await {
            ReadOutcome::Ok(req) => req,
            ReadOutcome::ConnectionClosed => panic!("unexpected ConnectionClosed"),
            ReadOutcome::Error => panic!("unexpected Error"),
        }
    }

    #[tokio::test]
    async fn read_request_get_no_body() {
        let wire = b"GET /api HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let req = read_request_once(wire).await;
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api");
        assert!(req.body.is_empty());
    }

    #[tokio::test]
    async fn read_request_post_content_length() {
        let wire = b"POST /api HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Content-Length: 5\r\n\
                     \r\n\
                     hello";
        let req = read_request_once(wire).await;
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, b"hello");
    }

    #[tokio::test]
    async fn read_request_oversized_content_length_rejected() {
        // Declared Content-Length above MAX_PROXY_BODY (10 MB) — the request
        // must be rejected up-front rather than the connection being silently
        // desynced by truncated forwarding. Regression test for PILOT-182
        // review #4 finding S1.
        let wire = b"POST /upload HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Content-Length: 100000000\r\n\
                     \r\n";
        let outcome = read_request_outcome(wire).await;
        assert!(
            matches!(outcome, ReadOutcome::Error),
            "expected Error for oversized Content-Length",
        );
    }

    #[tokio::test]
    async fn read_request_chunked_simple() {
        // Regression test for PILOT-182 review #4 finding S2: chunked request
        // bodies were silently dropped and forwarded as garbage.
        let wire = b"POST /api HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     5\r\nhello\r\n\
                     6\r\n world\r\n\
                     0\r\n\r\n";
        let req = read_request_once(wire).await;
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api");
        // The body retains the full chunked encoding bytes (we forward the
        // wire format, not a dechunked payload).
        assert_eq!(req.body, b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    }

    #[tokio::test]
    async fn read_request_chunked_empty_body() {
        let wire = b"POST /api HTTP/1.1\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     0\r\n\r\n";
        let req = read_request_once(wire).await;
        assert_eq!(req.body, b"0\r\n\r\n");
    }

    #[tokio::test]
    async fn read_request_chunked_with_trailers() {
        let wire = b"POST /api HTTP/1.1\r\n\
                     Transfer-Encoding: chunked\r\n\
                     Trailer: X-Checksum\r\n\
                     \r\n\
                     5\r\nhello\r\n\
                     0\r\n\
                     X-Checksum: abc123\r\n\
                     \r\n";
        let req = read_request_once(wire).await;
        assert_eq!(req.method, "POST");
        // Trailers are part of the body bytes (we forward verbatim).
        assert!(req.body.ends_with(b"X-Checksum: abc123\r\n\r\n"));
    }

    #[tokio::test]
    async fn read_request_chunked_truncated_returns_error() {
        // Chunk advertises 10 bytes but only 3 follow before EOF.
        let wire = b"POST /api HTTP/1.1\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     a\r\nabc";
        let outcome = read_request_outcome(wire).await;
        assert!(matches!(outcome, ReadOutcome::Error));
    }

    #[tokio::test]
    async fn read_request_chunked_invalid_size_returns_error() {
        // "zz" is not valid hex.
        let wire = b"POST /api HTTP/1.1\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     zz\r\nfoo\r\n0\r\n\r\n";
        let outcome = read_request_outcome(wire).await;
        assert!(matches!(outcome, ReadOutcome::Error));
    }

    #[tokio::test]
    async fn read_response_oversized_content_length_rejected() {
        // Same protection on the response side. Without this, an upstream
        // that advertises a huge Content-Length would cause read_response
        // to truncate at MAX_PROXY_BODY and leave the connection desynced.
        let wire = b"HTTP/1.1 200 OK\r\n\
                     Content-Length: 100000000\r\n\
                     \r\n";
        use tokio::io::AsyncWriteExt;
        let (mut client_side, server_side) = tokio::io::duplex(8192);
        client_side.write_all(wire).await.unwrap();
        client_side.shutdown().await.unwrap();
        drop(client_side);
        let mut server = server_side;
        let outcome = read_response(&mut server, "example.com").await;
        assert!(matches!(outcome, ReadOutcome::Error));
    }

    // ─── Review #5 fixes: TE/CL smuggling, overflow, precise chunked match ───

    #[test]
    fn is_chunked_transfer_encoding_basic() {
        let h = vec![("Transfer-Encoding".to_string(), "chunked".to_string())];
        assert!(is_chunked_transfer_encoding(&h));
    }

    #[test]
    fn is_chunked_transfer_encoding_case_insensitive() {
        let h = vec![("transfer-encoding".to_string(), "Chunked".to_string())];
        assert!(is_chunked_transfer_encoding(&h));
        let h = vec![("TRANSFER-ENCODING".to_string(), "CHUNKED".to_string())];
        assert!(is_chunked_transfer_encoding(&h));
    }

    #[test]
    fn is_chunked_transfer_encoding_rejects_substring_tricks() {
        // Regression tests for PILOT-182 review #5 finding SF3: the old
        // `contains("chunked")` check accepted these.
        let h = vec![("Transfer-Encoding".to_string(), "notchunked".to_string())];
        assert!(!is_chunked_transfer_encoding(&h));
        let h = vec![("Transfer-Encoding".to_string(), "chunkedz".to_string())];
        assert!(!is_chunked_transfer_encoding(&h));
        let h = vec![("Transfer-Encoding".to_string(), "Xchunked".to_string())];
        assert!(!is_chunked_transfer_encoding(&h));
    }

    #[test]
    fn is_chunked_transfer_encoding_handles_multiple_codings() {
        // Per RFC 7230 §3.3.1, chunked must be the final coding when
        // present, but any `chunked` token in any comma-separated list
        // is treated as chunked framing for our MITM purposes.
        let h = vec![("Transfer-Encoding".to_string(), "gzip, chunked".to_string())];
        assert!(is_chunked_transfer_encoding(&h));
        let h = vec![("Transfer-Encoding".to_string(), "chunked, gzip".to_string())];
        assert!(is_chunked_transfer_encoding(&h));
        let h = vec![("Transfer-Encoding".to_string(), "gzip".to_string())];
        assert!(!is_chunked_transfer_encoding(&h));
    }

    #[test]
    fn is_chunked_transfer_encoding_walks_multiple_headers() {
        // HTTP/1.1 allows multiple TE headers; any of them containing
        // `chunked` signals chunked framing.
        let h = vec![
            ("Transfer-Encoding".to_string(), "gzip".to_string()),
            ("Transfer-Encoding".to_string(), "chunked".to_string()),
        ];
        assert!(is_chunked_transfer_encoding(&h));
    }

    #[test]
    fn has_connection_close_single_token() {
        let h = vec![("Connection".to_string(), "close".to_string())];
        assert!(has_connection_close(&h));
        let h = vec![("connection".to_string(), "Close".to_string())];
        assert!(has_connection_close(&h));
    }

    #[test]
    fn has_connection_close_mixed_with_keep_alive() {
        // RFC 7230 §6.1: Connection is a comma-separated list. A client or
        // upstream can legally send `keep-alive, close` — we must still
        // close the connection after this message.
        let h = vec![("Connection".to_string(), "keep-alive, close".to_string())];
        assert!(has_connection_close(&h));
        let h = vec![("Connection".to_string(), "close, keep-alive".to_string())];
        assert!(has_connection_close(&h));
    }

    #[test]
    fn has_connection_close_walks_multiple_headers() {
        // HTTP/1.1 allows multiple Connection headers; any of them containing
        // `close` signals end-of-connection.
        let h = vec![
            ("Connection".to_string(), "keep-alive".to_string()),
            ("Connection".to_string(), "close".to_string()),
        ];
        assert!(has_connection_close(&h));
    }

    #[test]
    fn has_connection_close_rejects_substring_tricks() {
        // Must match the token `close` strictly, not substrings — otherwise
        // `Connection: closed` or `Connection: not-close` would false-positive.
        let h = vec![("Connection".to_string(), "closed".to_string())];
        assert!(!has_connection_close(&h));
        let h = vec![("Connection".to_string(), "not-close".to_string())];
        assert!(!has_connection_close(&h));
        let h = vec![("Connection".to_string(), "keep-alive".to_string())];
        assert!(!has_connection_close(&h));
    }

    #[test]
    fn has_connection_close_absent_header() {
        let h: Vec<(String, String)> = vec![];
        assert!(!has_connection_close(&h));
        let h = vec![("Content-Length".to_string(), "0".to_string())];
        assert!(!has_connection_close(&h));
    }

    #[tokio::test]
    async fn read_request_rejects_te_and_cl_conflict() {
        // Regression test for PILOT-182 review #5 finding SF1 (HTTP
        // request smuggling via conflicting framing headers).
        let wire = b"POST /api HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Transfer-Encoding: chunked\r\n\
                     Content-Length: 5\r\n\
                     \r\n\
                     0\r\n\r\n";
        let outcome = read_request_outcome(wire).await;
        assert!(
            matches!(outcome, ReadOutcome::Error),
            "expected Error for TE+CL conflict",
        );
    }

    #[tokio::test]
    async fn read_response_rejects_te_and_cl_conflict() {
        let wire = b"HTTP/1.1 200 OK\r\n\
                     Transfer-Encoding: chunked\r\n\
                     Content-Length: 5\r\n\
                     \r\n\
                     0\r\n\r\n";
        use tokio::io::AsyncWriteExt;
        let (mut client_side, server_side) = tokio::io::duplex(8192);
        client_side.write_all(wire).await.unwrap();
        client_side.shutdown().await.unwrap();
        drop(client_side);
        let mut server = server_side;
        let outcome = read_response(&mut server, "example.com").await;
        assert!(matches!(outcome, ReadOutcome::Error));
    }

    #[tokio::test]
    async fn read_request_rejects_notchunked_transfer_encoding() {
        // Regression test for PILOT-182 review #5 finding SF3: the old
        // substring match treated `notchunked` as chunked, which is both
        // wrong on the wire and a potential smuggling gadget. With the
        // precise token match, `notchunked` isn't a recognised coding, so
        // the request falls through to the non-chunked path and — because
        // there's no Content-Length and this isn't a recognised coding —
        // is read as a zero-byte body.
        let wire = b"POST /api HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Transfer-Encoding: notchunked\r\n\
                     \r\n";
        let req = read_request_once(wire).await;
        assert!(req.body.is_empty());
    }

    #[tokio::test]
    async fn read_request_chunked_with_compression_coding() {
        // `Transfer-Encoding: gzip, chunked` — valid per RFC 7230. The
        // body should be parsed as chunked (we don't decompress).
        let wire = b"POST /api HTTP/1.1\r\n\
                     Host: example.com\r\n\
                     Transfer-Encoding: gzip, chunked\r\n\
                     \r\n\
                     5\r\nhello\r\n\
                     0\r\n\r\n";
        let req = read_request_once(wire).await;
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, b"5\r\nhello\r\n0\r\n\r\n");
    }

    #[tokio::test]
    async fn read_request_chunked_overflow_size_rejected() {
        // Regression test for PILOT-182 review #5 finding SF2: a chunk
        // size of usize::MAX in hex would have wrapped `cursor +
        // chunk_size + 2` in release builds. With checked_add, this is
        // now rejected with an explicit "chunk size overflow" error.
        let wire = b"POST /api HTTP/1.1\r\n\
                     Transfer-Encoding: chunked\r\n\
                     \r\n\
                     ffffffffffffffff\r\n";
        let outcome = read_request_outcome(wire).await;
        assert!(matches!(outcome, ReadOutcome::Error));
    }

    #[tokio::test]
    async fn read_request_chunked_does_not_leak_pipelined_tail_into_body() {
        // Regression test for PILOT-182 review #5 MUST FIX.
        //
        // Before the fix, `read_chunked_body::read_line` used a 256-byte
        // buffered read, and before that the header-phase read of
        // `read_request` could pull bytes from the next pipelined
        // request into `buf`. Those bytes ended up in `req.body` and
        // were forwarded upstream as garbage tail after the first
        // request's body — a request-smuggling / desync symptom.
        //
        // With the `buf.truncate(cursor)` fix at the end of
        // `read_chunked_body`, `req.body` and `req.raw_bytes` contain
        // exactly the first request's bytes with no pipelined leakage.
        //
        // Note: in Pilot's use case (mobile-test MITM proxy, URLSession /
        // fetch / axios clients) HTTP/1.1 pipelining of chunked uploads
        // is extraordinarily rare — the pipelined second request being
        // dropped from the wire is a documented acceptable limitation.
        // This test locks in the "no garbage forwarded upstream" invariant.
        use tokio::io::AsyncWriteExt;
        let first_req =
            b"POST /first HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n\
              0\r\n\r\n";
        let second_req = b"GET /second HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let mut wire = Vec::new();
        wire.extend_from_slice(first_req);
        wire.extend_from_slice(second_req);

        let (mut client_side, server_side) = tokio::io::duplex(8192);
        client_side.write_all(&wire).await.unwrap();
        client_side.shutdown().await.unwrap();
        drop(client_side);
        let mut server = server_side;
        let first = match read_request(&mut server, "example.com").await {
            ReadOutcome::Ok(r) => r,
            other => panic!(
                "first request outcome: {:?}",
                std::mem::discriminant(&other)
            ),
        };
        assert_eq!(first.method, "POST");
        assert_eq!(first.path, "/first");
        // The body must contain EXACTLY the chunked terminator.
        assert_eq!(first.body, b"0\r\n\r\n");
        // Neither the body nor the raw forwarded bytes may contain any
        // trace of the second pipelined request.
        assert!(
            !first.body.windows(4).any(|w| w == b"GET "),
            "second request bytes leaked into first.body",
        );
        assert!(
            !first.raw_bytes.windows(4).any(|w| w == b"GET "),
            "second request bytes leaked into first.raw_bytes",
        );
        // raw_bytes must end with the chunked terminator, nothing more.
        assert!(first.raw_bytes.ends_with(b"0\r\n\r\n"));
    }
}
