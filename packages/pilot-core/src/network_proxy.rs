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
    /// Start the proxy on an ephemeral port. Returns immediately.
    /// The `mitm_ca` is used to generate per-host TLS certificates for HTTPS
    /// interception.
    pub async fn start(mitm_ca: Arc<MitmAuthority>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .context("Failed to bind proxy port")?;
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

/// Read a full HTTP/1.x request (headers + body) from a client stream,
/// returning structured request data plus the raw bytes for forwarding.
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

    // Read request body if Content-Length is set (capped to prevent OOM).
    let content_length: usize = get_header(&headers, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_PROXY_BODY);
    let body_so_far = buf.len().saturating_sub(header_end);
    if content_length > body_so_far {
        let remaining = content_length - body_so_far;
        let mut body_buf = vec![0u8; remaining];
        if let Err(e) = client.read_exact(&mut body_buf).await {
            debug!("MITM reading request body for {hostname}: {e}");
            return ReadOutcome::Error;
        }
        buf.extend_from_slice(&body_buf);
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

                        let is_chunked = headers.iter().any(|(k, v)| {
                            k.eq_ignore_ascii_case("transfer-encoding")
                                && v.to_lowercase().contains("chunked")
                        });
                        let content_length: Option<usize> = headers
                            .iter()
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, v)| v.trim().parse::<usize>().ok());

                        cached_headers = headers;

                        framing = Some(if matches!(status, 100..=199 | 204 | 304) {
                            BodyFraming::NoBody
                        } else if is_chunked {
                            BodyFraming::Chunked {
                                header_end,
                                chunked_scan_cursor: header_end,
                            }
                        } else if let Some(cl) = content_length {
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
                        let done = buf[start..].windows(5).any(|w| w == b"\r\n0\r\n")
                            && buf.ends_with(b"\r\n\r\n");
                        *chunked_scan_cursor = buf.len();
                        done
                    }
                    Some(BodyFraming::UntilClose) => false,
                };
                if complete {
                    break;
                }
                if buf.len() > MAX_PROXY_BODY {
                    break;
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

/// Re-serialize a [`ParsedRequest`] back to HTTP/1.1 wire format. Called
/// after a `NetworkHandler::on_request` hook mutates `method` / `path` /
/// `headers` / `body`, so that the `raw_bytes` forwarded upstream stays in
/// sync with the structured fields. The no-handler hot path never calls
/// this — the original upstream bytes are forwarded verbatim.
fn reencode_request(req: &ParsedRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(req.raw_bytes.len().max(256));
    out.extend_from_slice(req.method.as_bytes());
    out.push(b' ');
    out.extend_from_slice(req.path.as_bytes());
    out.extend_from_slice(b" HTTP/1.1\r\n");
    for (k, v) in &req.headers {
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v.as_bytes());
        out.extend_from_slice(b"\r\n");
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
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v.as_bytes());
        out.extend_from_slice(b"\r\n");
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
        // mutated) structured fields so downstream writes see the new shape.
        if let Some(h) = handler.as_ref() {
            let maybe_synth = h.on_request(&mut req).await;
            req.raw_bytes = reencode_request(&req);
            if let Some(mut synth) = maybe_synth {
                if synth.raw_bytes.is_empty() {
                    synth.raw_bytes = reencode_response(&synth);
                }
                if client_stream.write_all(&synth.raw_bytes).await.is_err() {
                    return;
                }
                let close = get_header(&synth.headers, "connection")
                    .map(|v| v.eq_ignore_ascii_case("close"))
                    .unwrap_or(false);
                record_entry(&state, &req, &synth, hostname, is_https, start).await;
                if close {
                    return;
                }
                continue;
            }
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
        let connection_close = get_header(&resp.headers, "connection")
            .map(|v| v.eq_ignore_ascii_case("close"))
            .unwrap_or(false);

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

    // Check for chunked transfer encoding
    let is_chunked = header_lower
        .lines()
        .any(|line| line.starts_with("transfer-encoding:") && line.contains("chunked"));

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
    let mut peek = [0u8; 3];
    if let Err(e) = client.read_exact(&mut peek).await {
        debug!(%dst_host, dst_port, "transparent-TCP peek failed: {e}");
        return;
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
    let start =
        match tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), chained)
            .await
        {
            Ok(s) => s,
            Err(e) => {
                debug!(%dst_host, dst_port, "failed reading TLS ClientHello: {e}");
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
}
