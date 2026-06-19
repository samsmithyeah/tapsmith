//! HTTP/HTTPS proxy for network traffic capture during tracing.
//!
//! Supports two interception modes:
//!
//! * **Forward proxy** — the device is configured to send all traffic through
//!   this proxy (via HTTP CONNECT for HTTPS, absolute-URL for HTTP). Used by
//!   iOS physical devices.
//!
//! * **Transparent redirect** — an OS-level mechanism (iOS Network Extension
//!   or Android iptables) silently reroutes device TCP connections to the
//!   proxy port. The proxy peeks the first bytes to detect TLS vs. plain
//!   HTTP, extracts the hostname from the TLS SNI or HTTP Host header, and
//!   proceeds with MITM interception. Used by iOS simulators and Android.
//!
//! For HTTPS, performs MITM interception using per-host certificates signed by
//! the Tapsmith CA to decrypt and capture request/response content. The MITM
//! engine speaks HTTP/1.1 only; TLS connections that cannot be downgraded —
//! HTTP/2-only ALPN offers (gRPC, Firestore) or hosts listed in
//! `trace.networkPassthroughHosts` (certificate pinning) — are tunneled
//! end-to-end without interception instead of being dropped (PILOT-231).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_rustls::TlsConnector;
use tracing::{debug, info, warn};

use crate::mitm_ca::MitmAuthority;
use crate::pac;

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
    /// How this request was handled by a route: "mocked", "aborted",
    /// "continued", "fetched", or "" (no route matched). The special value
    /// "passthrough" marks a synthetic per-connection entry for TLS traffic
    /// tunneled without MITM (h2-only ALPN or `trace.networkPassthroughHosts`)
    /// — no request/response detail is available for those.
    pub route_action: String,
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
    /// Set by `route.continue({ url })` when the override URL targets a
    /// different origin.
    pub override_host: Option<OverrideOrigin>,
}

/// Cross-origin target for `route.continue({ url })` redirects.
#[derive(Debug, Clone)]
pub(crate) struct OverrideOrigin {
    pub host: String,
    pub port: u16,
    pub is_https: bool,
}

impl OverrideOrigin {
    pub fn from_parsed_url(parsed: &url::Url) -> Option<Self> {
        let host = parsed.host_str().unwrap_or("").to_string();
        if host.is_empty() {
            return None;
        }
        let is_https = parsed.scheme() == "https";
        let port = parsed
            .port_or_known_default()
            .unwrap_or(if is_https { 443 } else { 80 });
        Some(Self {
            host,
            port,
            is_https,
        })
    }

    pub fn url(&self, path: &str) -> String {
        let scheme = if self.is_https { "https" } else { "http" };
        format!("{scheme}://{}:{}{}", self.host, self.port, path)
    }

    pub fn host_header_value(&self) -> String {
        if (self.is_https && self.port == 443) || (!self.is_https && self.port == 80) {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
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

/// Outcome of `NetworkHandler::on_request`. Three distinct states because
/// "no route matched" (passthrough) and "route matched + `continue()`" must
/// be distinguishable — they look the same to the proxy (forward upstream)
/// but are different in the trace log's `route_action` field.
pub(crate) enum RequestOutcome {
    /// No registered route matched this URL. Forward the original request
    /// upstream, log as untracked passthrough.
    NotMatched,
    /// A route matched and the handler chose `continue()` (possibly with
    /// mutations already applied to `req`). Forward upstream, log as
    /// `route_action: "continued"`.
    Continued,
    /// A route matched and produced a synthetic response (abort/fulfill).
    /// Do not forward upstream; return `resp` to the client.
    Synthesized(ParsedResponse),
}

/// Hook trait for request/response transformation and synthetic responses.
///
/// All methods have no-op defaults. PILOT-182 adds the insertion points;
/// `route_handler::RouteInterceptHandler` provides the live implementation
/// that bridges requests to the SDK's `device.route()` handlers.
#[async_trait::async_trait]
pub(crate) trait NetworkHandler: Send + Sync {
    /// Inspect (and optionally mutate) a request before it's forwarded to
    /// upstream. See [`RequestOutcome`] for the three possible states.
    /// `hostname` and `is_https` are provided so the handler can
    /// reconstruct the full URL.
    async fn on_request(
        &self,
        _req: &mut ParsedRequest,
        _hostname: &str,
        _is_https: bool,
    ) -> RequestOutcome {
        RequestOutcome::NotMatched
    }

    /// Inspect (and optionally mutate) a response before it's written back
    /// to the client. Used for header/body rewriting and event notifications.
    async fn on_response(
        &self,
        _req: &ParsedRequest,
        _hostname: &str,
        _is_https: bool,
        _resp: &mut ParsedResponse,
    ) {
    }

    /// Fire a best-effort request notification to subscribers
    /// (`device.on('request', …)` / `device.waitForRequest`). Called once
    /// per request, regardless of whether `on_request` returned a synthetic
    /// response. Non-blocking — implementations should drop the message if
    /// the subscriber channel is full.
    async fn notify_request(&self, _req: &ParsedRequest, _hostname: &str, _is_https: bool) {}

    /// Fire a best-effort response notification to subscribers
    /// (`device.on('response', …)` / `device.waitForResponse`). `route_action`
    /// is one of `""`, `"continued"`, `"mocked"`, `"aborted"` and mirrors
    /// the value recorded in `CapturedEntry`.
    async fn notify_response(
        &self,
        _req: &ParsedRequest,
        _resp: &ParsedResponse,
        _hostname: &str,
        _is_https: bool,
        _route_action: &str,
    ) {
    }

    /// Whether any registered route matches `url`. The HTTP/2 path calls this
    /// before reading the request body to decide whether to buffer the body
    /// (so `on_request` can inspect/mutate it) or stream it straight through.
    /// Default: nothing matches.
    async fn matches(&self, _url: &str) -> bool {
        false
    }
}

/// Shared state for the proxy server.
pub(crate) struct ProxyState {
    entries: Vec<CapturedEntry>,
    tls_client_config: Arc<ClientConfig>,
    /// Upstream TLS config for the HTTP/2 pipeline (PILOT-245). Offers `h2`
    /// first then `http/1.1` so the proxy can detect an origin that only
    /// speaks HTTP/1.1 and fall back accordingly. Kept separate from
    /// `tls_client_config` (pinned to http/1.1) which the HTTP/1.1 path uses.
    h2_client_config: Arc<ClientConfig>,
    /// Optional transformation handler. `None` today (PILOT-182); populated
    /// later when request/response modification lands. The handler field is
    /// read from inside `handle_mitm_http` — even though it's always `None`
    /// at runtime, the code path exists and the types are exercised, so the
    /// future roadmap work is a pure drop-in.
    handler: Option<Arc<dyn NetworkHandler>>,
    /// Glob patterns used by the `/tapsmith.pac` PAC script to decide which
    /// hosts route through the proxy vs. go DIRECT. Sourced from the user's
    /// `trace.networkHosts` in tapsmith.config.ts and kept up-to-date by
    /// `NetworkProxy::set_network_hosts`. Empty = route everything.
    network_hosts: Vec<String>,
    /// Pre-compiled glob patterns (see [`compile_host_glob`]) for hosts whose
    /// TLS connections are tunneled end-to-end instead of MITM'd (no capture,
    /// no routing — the app talks to the real server). Sourced from the
    /// user's `trace.networkPassthroughHosts` and kept up-to-date by
    /// `NetworkProxy::set_passthrough_hosts`. Useful for cert-pinned hosts.
    /// Matched against the ClientHello SNI. Empty = no host-based passthrough
    /// (ALPN-based h2 passthrough still applies).
    passthrough_hosts: Vec<regex::Regex>,
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
        let mut tls_client_config = ClientConfig::builder()
            .with_root_certificates(root_store.clone())
            .with_no_client_auth();
        // The HTTP/1.1 path re-serializes everything as HTTP/1.1, so make that
        // explicit to upstream servers rather than relying on their
        // no-ALPN default.
        tls_client_config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let tls_client_config = Arc::new(tls_client_config);

        // HTTP/2 pipeline upstream config (PILOT-245): offer h2 first, then
        // http/1.1 so we can detect (and fall back for) an origin that only
        // speaks HTTP/1.1.
        let mut h2_client_config = ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        h2_client_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let h2_client_config = Arc::new(h2_client_config);

        let state = Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config,
            h2_client_config,
            handler: None,
            network_hosts: Vec::new(),
            passthrough_hosts: Vec::new(),
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

    /// Update the PAC host-allowlist served at `/tapsmith.pac`. Called from
    /// `grpc_server::set_device` whenever the CLI hands us a (possibly
    /// changed) `trace.networkHosts`. Safe to call while the proxy is
    /// serving traffic — the next PAC fetch (or iOS re-evaluation) picks
    /// up the new list.
    ///
    /// Only called from `#[cfg(target_os = "macos")]` blocks (physical iOS
    /// is macOS-only), so gated to avoid dead-code warnings on Linux CI.
    #[cfg(target_os = "macos")]
    pub async fn set_network_hosts(&self, hosts: Vec<String>) {
        let mut state = self.state.lock().await;
        state.network_hosts = hosts;
    }

    /// Update the host-glob passthrough list (`trace.networkPassthroughHosts`).
    /// TLS connections whose SNI matches any of these globs are tunneled
    /// end-to-end without MITM — no capture, no routing — so cert-pinned
    /// hosts keep working during tests. Globs are compiled to regexes here,
    /// once, so per-connection matching stays cheap. Safe to call while the
    /// proxy is serving traffic; applies to connections accepted after the
    /// call.
    pub async fn set_passthrough_hosts(&self, hosts: Vec<String>) {
        let compiled = hosts
            .iter()
            .filter_map(|pattern| {
                let re = compile_host_glob(pattern);
                if re.is_none() {
                    warn!(%pattern, "Ignoring invalid networkPassthroughHosts pattern");
                }
                re
            })
            .collect();
        let mut state = self.state.lock().await;
        state.passthrough_hosts = compiled;
    }

    /// Set a [`NetworkHandler`] implementation on the proxy. Requests
    /// arriving after this call will be routed through the handler's
    /// `on_request` / `on_response` hooks. Used by the `NetworkRoute`
    /// streaming RPC to install the route interception handler.
    pub async fn set_handler(&self, handler: Arc<dyn NetworkHandler>) {
        self.state.lock().await.handler = Some(handler);
    }

    /// Remove the active handler. Subsequent requests pass through
    /// unmodified.
    pub async fn clear_handler(&self) {
        self.state.lock().await.handler = None;
    }

    /// Clear any captured entries without stopping the proxy. Used when a
    /// test session starts network capture on a proxy that was pre-started
    /// for OCSP passthrough during agent launch — pre-start OCSP/CRL traffic
    /// would otherwise leak into the captured entries of the first test.
    pub async fn reset_entries(&self) {
        let mut state = self.state.lock().await;
        state.entries.clear();
    }

    /// Return captured entries and clear the buffer without stopping the
    /// proxy listener or device routing. Used by the runner to finalize a
    /// test trace while keeping capture stable for the next test.
    pub async fn drain_entries(&self) -> Vec<CapturedEntry> {
        let mut state = self.state.lock().await;
        std::mem::take(&mut state.entries)
    }

    /// Stop the proxy and return all captured entries.
    pub async fn stop(self) -> Vec<CapturedEntry> {
        let _ = self.shutdown_tx.send(());
        // Give in-flight requests a moment to complete
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let mut state = self.state.lock().await;
        std::mem::take(&mut state.entries)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Build a `host:port` connect target, bracketing bare IPv6 address literals
/// so `TcpStream::connect` can parse them (`2a00:…` → `[2a00:…]:443`).
///
/// The iOS NE redirector hands us the connection's raw original destination,
/// which is frequently an IPv6 address (PILOT-242). Without brackets,
/// `format!("{host}:{port}")` produces an unparseable address and every
/// IPv6 flow fails to dial — so the app's IPv6-first connections (Firestore
/// gRPC, etc.) break under capture. Hostnames and already-bracketed literals
/// pass through unchanged.
fn join_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Handle a single proxy connection.
///
/// Supports three connection types:
///
/// 1. **Forward-proxy HTTP** — `GET http://host/path` or `CONNECT host:port`
///    (classic HTTP proxy protocol).
/// 2. **Transparent TLS** — raw TLS ClientHello (iptables redirect on
///    Android, or `handle_transparent_tcp` from the iOS NE redirector).
///    Detected by peeking the first 3 bytes for `0x16 0x03 0x0?`.
/// 3. **Transparent HTTP** — plain HTTP with a relative path (`GET /path`)
///    arriving via iptables redirect. The Host header provides the upstream
///    destination.
async fn handle_connection(
    mut client: TcpStream,
    addr: SocketAddr,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) {
    debug!(%addr, "New proxy connection");

    // Read the first chunk from the client and ensure we have at least 3
    // bytes — enough to distinguish a TLS ClientHello (`0x16 0x03 0x0?`)
    // from an HTTP request line (starts with an ASCII method letter > 0x40).
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 8192];
    while buf.len() < 3 {
        match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read(&mut tmp)).await {
            Ok(Ok(0)) => return,
            Ok(Ok(n)) => buf.extend_from_slice(&tmp[..n]),
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

    // Transparent TLS: the first 3 bytes of a TLS record are
    //   0x16 (Handshake) + 0x03 (SSL/TLS major) + 0x00..=0x04 (minor).
    // HTTP request lines always start with an ASCII method letter (> 0x40),
    // so this can't collide with any valid HTTP request.
    if buf[0] == 0x16 && buf[1] == 0x03 && buf[2] <= 0x04 {
        debug!(%addr, "Detected transparent TLS connection");
        let chained = PrefixedStream::new(buf, client);
        // Port 443: the iptables rules only redirect --dport 443 to TLS.
        handle_transparent_tls(chained, String::new(), 443, state, mitm_ca).await;
        return;
    }

    // Not TLS — continue reading until we have complete HTTP headers.
    let mut header_buf = buf;
    if !header_buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let mut tmp = vec![0u8; 8192];
        loop {
            match tokio::time::timeout(CLIENT_READ_TIMEOUT, client.read(&mut tmp)).await {
                Ok(Ok(0)) => return,
                Ok(Ok(n)) => {
                    header_buf.extend_from_slice(&tmp[..n]);
                    if header_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                    if header_buf.len() > 65536 {
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
    }

    let request_str = String::from_utf8_lossy(&header_buf);
    let first_line = request_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    if parts.len() < 3 {
        debug!("Invalid HTTP request line: {first_line}");
        return;
    }

    let method = parts[0];
    let target = parts[1];

    // Direct (non-proxied) GET for the PAC script. iOS fetches this on
    // Wi-Fi join when the device's profile uses `ProxyType=Auto`. Served
    // straight out of ProxyState — no upstream round-trip.
    if method == "GET" && target == "/tapsmith.pac" {
        handle_pac_request(client, addr, &header_buf, state).await;
        return;
    }

    if method == "CONNECT" {
        handle_connect(client, target, state, mitm_ca).await;
    } else if target.starts_with("http://") || target.starts_with("https://") {
        // Forward-proxy HTTP — absolute URL in the request line.
        handle_http(client, method, target, &header_buf, state).await;
    } else {
        // Transparent HTTP — relative path from iptables redirect. Use
        // `handle_mitm_http` (not `handle_http`) because it supports
        // chunked transfer-encoding and HTTP keep-alive.
        let (headers, _) = parse_headers(&header_buf);
        if let Some(host) = get_header(&headers, "host") {
            let hostname = host.split(':').next().unwrap_or(host);
            if let Some(upstream_tcp) = dial_upstream(hostname, 80).await {
                let chained = PrefixedStream::new(header_buf, client);
                handle_mitm_http(chained, upstream_tcp, hostname, state, false).await;
            }
        } else {
            debug!("Transparent HTTP request missing Host header: {first_line}");
        }
    }
}

/// Serve `/tapsmith.pac` — the Proxy Auto-Config script iOS fetches when its
/// Wi-Fi payload uses `ProxyType=Auto`. The body is generated from the
/// current `network_hosts` allowlist stored in `ProxyState` and the Host
/// header from the incoming request (so the PAC's proxy target is
/// guaranteed to be an address iOS can reach — it's the same one it just
/// used to fetch the PAC).
///
/// Every fetch is logged at `info!` level with the client address and the
/// number of hosts in the allowlist. That's deliberate: iOS's PAC cache
/// is aggressive and opaque, and having an authoritative log of "iOS
/// re-fetched the PAC at T" (or the absence of one) is the difference
/// between a solvable stale-filter bug and a two-day hunt. Tune volume
/// down to `debug!` later if it gets noisy; for now the observability is
/// worth more than the log lines.
async fn handle_pac_request(
    mut client: TcpStream,
    client_addr: SocketAddr,
    initial_data: &[u8],
    state: Arc<Mutex<ProxyState>>,
) {
    // Pull the Host header out of the already-read request. iOS sends
    // `Host: <ip>:<port>` (or just `<ip>` with default port) for the
    // direct GET to the PAC server. We reuse whichever address that is
    // as the PAC's proxy destination — matches what iOS actually reached.
    let (req_headers, _) = parse_headers(initial_data);
    let host_header = get_header(&req_headers, "host").unwrap_or_default();
    let (proxy_host, proxy_port) = match parse_host_header(host_header) {
        Some(v) => v,
        None => {
            warn!(
                %client_addr,
                host_header,
                "PAC fetch missing or unparsable Host header — refusing with 400"
            );
            let _ = client
                .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                .await;
            return;
        }
    };

    let network_hosts = state.lock().await.network_hosts.clone();
    let body = pac::generate_pac_script(&proxy_host, proxy_port, &network_hosts);
    let body_bytes = body.as_bytes();

    info!(
        %client_addr,
        proxy_host,
        proxy_port,
        host_count = network_hosts.len(),
        bytes = body_bytes.len(),
        "Served /tapsmith.pac"
    );

    let headers = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/x-ns-proxy-autoconfig\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n",
        body_bytes.len()
    );
    if let Err(e) = client.write_all(headers.as_bytes()).await {
        debug!("PAC response header write failed: {e}");
        return;
    }
    if let Err(e) = client.write_all(body_bytes).await {
        debug!("PAC response body write failed: {e}");
    }
}

/// Parse a `Host:` header value of the form `<host>` or `<host>:<port>`
/// into its components. Returns `None` when the header is empty or the
/// port part can't be parsed. IPv6 literals aren't handled — iOS only
/// uses IPv4 LAN addresses for physical-device Wi-Fi proxies today.
fn parse_host_header(header: &str) -> Option<(String, u16)> {
    let trimmed = header.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((host, port_str)) = trimmed.rsplit_once(':') {
        let port: u16 = port_str.parse().ok()?;
        Some((host.to_string(), port))
    } else {
        // No port in the header — default to port 80 for HTTP.
        Some((trimmed.to_string(), 80))
    }
}

/// Handle HTTP CONNECT with MITM TLS interception.
///
/// After acknowledging the tunnel, delegates to [`handle_transparent_tls`]:
/// same SNI fallback (the CONNECT host when the ClientHello has no SNI),
/// same upstream resolution (the CONNECT host:port), and — critically — the
/// same ALPN/host-based passthrough decision (PILOT-231).
///
/// The shared path establishes the client-side TLS session before dialing
/// upstream. This keeps `waitForRequest()` and `route.fulfill()` independent
/// from transient upstream DNS/connectivity stalls: once the app has sent
/// the decrypted HTTP request, the proxy can emit the request event or
/// synthesize a route response without waiting for the real server.
async fn handle_connect(
    mut client: TcpStream,
    target: &str,
    state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) {
    let (connect_host, connect_port) = parse_connect_target(target);

    // Tell the client the tunnel is established
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }

    handle_transparent_tls(client, connect_host, connect_port, state, mitm_ca).await;
}

fn parse_connect_target(target: &str) -> (String, u16) {
    if let Some((host, port)) = target.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return (host.to_string(), port);
        }
    }
    (target.to_string(), 443)
}

fn bad_gateway_response() -> ParsedResponse {
    let mut resp = ParsedResponse {
        status_code: 502,
        headers: vec![
            ("Content-Length".to_string(), "0".to_string()),
            ("Connection".to_string(), "close".to_string()),
        ],
        body: Vec::new(),
        raw_bytes: Vec::new(),
    };
    resp.raw_bytes = reencode_response(&resp);
    resp
}

struct BadGatewayContext<'a> {
    handler: Option<&'a Arc<dyn NetworkHandler>>,
    req: &'a ParsedRequest,
    hostname: &'a str,
    is_https: bool,
    start_ms: u64,
    route_action: &'a str,
}

async fn write_bad_gateway<C>(
    client_stream: &mut C,
    state: &Arc<Mutex<ProxyState>>,
    ctx: BadGatewayContext<'_>,
) where
    C: AsyncWrite + Unpin,
{
    let resp = bad_gateway_response();
    let _ = client_stream.write_all(&resp.raw_bytes).await;
    if let Some(h) = ctx.handler {
        h.notify_response(ctx.req, &resp, ctx.hostname, ctx.is_https, ctx.route_action)
            .await;
    }
    record_entry(
        state,
        ctx.req,
        &resp,
        ctx.hostname,
        ctx.is_https,
        ctx.start_ms,
        ctx.route_action,
    )
    .await;
}

async fn connect_tls_upstream(
    state: &Arc<Mutex<ProxyState>>,
    upstream_host: &str,
    upstream_port: u16,
    server_name_host: &str,
) -> Option<tokio_rustls::client::TlsStream<TcpStream>> {
    let addr = join_host_port(upstream_host, upstream_port);
    let upstream_tcp =
        match tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                debug!("CONNECT failed to {addr}: {e}");
                return None;
            }
            Err(_) => {
                debug!("CONNECT timed out to {addr}");
                return None;
            }
        };

    let tls_client_config = state.lock().await.tls_client_config.clone();
    let server_name = match rustls::pki_types::ServerName::try_from(server_name_host.to_string()) {
        Ok(sn) => sn,
        Err(e) => {
            debug!("Invalid server name '{server_name_host}': {e}");
            return None;
        }
    };

    match TlsConnector::from(tls_client_config)
        .connect(server_name, upstream_tcp)
        .await
    {
        Ok(s) => Some(s),
        Err(e) => {
            debug!("TLS handshake with upstream {server_name_host} failed: {e}");
            None
        }
    }
}

/// Proxy decrypted HTTPS traffic, connecting upstream only after the client
/// request has been parsed and route hooks have had a chance to synthesize a
/// response. This preserves Playwright-like request timing for `waitForRequest`
/// and avoids requiring upstream availability for `route.fulfill()`.
async fn handle_mitm_https_lazy_upstream<C>(
    mut client_stream: C,
    hostname: &str,
    upstream_host: &str,
    upstream_port: u16,
    state: Arc<Mutex<ProxyState>>,
) where
    C: AsyncRead + AsyncWrite + Unpin,
{
    let mut upstream_stream: Option<tokio_rustls::client::TlsStream<TcpStream>> = None;

    loop {
        let handler = state.lock().await.handler.clone();
        let start = now_ms();

        let mut req = match read_request(&mut client_stream, hostname).await {
            ReadOutcome::Ok(r) => r,
            ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
        };

        if let Some(h) = handler.as_ref() {
            h.notify_request(&req, hostname, true).await;
        }

        let mut route_action_on_pass: &'static str = "";
        if let Some(h) = handler.as_ref() {
            match h.on_request(&mut req, hostname, true).await {
                RequestOutcome::Synthesized(mut synth) => {
                    if synth.status_code == 0 {
                        h.notify_response(&req, &synth, hostname, true, "aborted")
                            .await;
                        record_entry(&state, &req, &synth, hostname, true, start, "aborted").await;
                        return;
                    }
                    if synth.raw_bytes.is_empty() {
                        synth.raw_bytes = reencode_response(&synth);
                    }
                    if client_stream.write_all(&synth.raw_bytes).await.is_err() {
                        return;
                    }
                    let close = has_connection_close(&synth.headers);
                    h.notify_response(&req, &synth, hostname, true, "mocked")
                        .await;
                    record_entry(&state, &req, &synth, hostname, true, start, "mocked").await;
                    if close {
                        return;
                    }
                    continue;
                }
                RequestOutcome::Continued => {
                    req.raw_bytes = reencode_request(&req);
                    route_action_on_pass = "continued";
                }
                RequestOutcome::NotMatched => {}
            }
        }

        let (effective_hostname, effective_is_https) = match req.override_host {
            Some(ref origin) => (origin.host.clone(), origin.is_https),
            None => (hostname.to_string(), true),
        };

        let mut resp = if let Some(ref origin) = req.override_host {
            let url = origin.url(&req.path);
            match crate::route_handler::fetch_upstream(&url, &req.method, &req.headers, &req.body)
                .await
            {
                Some(r) => r,
                None => {
                    write_bad_gateway(
                        &mut client_stream,
                        &state,
                        BadGatewayContext {
                            handler: handler.as_ref(),
                            req: &req,
                            hostname: &effective_hostname,
                            is_https: effective_is_https,
                            start_ms: start,
                            route_action: route_action_on_pass,
                        },
                    )
                    .await;
                    return;
                }
            }
        } else {
            if upstream_stream.is_none() {
                let Some(s) =
                    connect_tls_upstream(&state, upstream_host, upstream_port, hostname).await
                else {
                    write_bad_gateway(
                        &mut client_stream,
                        &state,
                        BadGatewayContext {
                            handler: handler.as_ref(),
                            req: &req,
                            hostname,
                            is_https: true,
                            start_ms: start,
                            route_action: route_action_on_pass,
                        },
                    )
                    .await;
                    return;
                };
                upstream_stream = Some(s);
            }

            let upstream = upstream_stream.as_mut().expect("upstream initialized");
            if upstream.write_all(&req.raw_bytes).await.is_err() {
                return;
            }
            match read_response(upstream, hostname).await {
                ReadOutcome::Ok(r) => r,
                ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
            }
        };

        if let Some(h) = handler.as_ref() {
            h.on_response(&req, &effective_hostname, effective_is_https, &mut resp)
                .await;
            resp.raw_bytes = reencode_response(&resp);
        }

        if client_stream.write_all(&resp.raw_bytes).await.is_err() {
            return;
        }

        let connection_close = has_connection_close(&resp.headers);

        if let Some(h) = handler.as_ref() {
            h.notify_response(
                &req,
                &resp,
                &effective_hostname,
                effective_is_https,
                route_action_on_pass,
            )
            .await;
        }
        record_entry(
            &state,
            &req,
            &resp,
            &effective_hostname,
            effective_is_https,
            start,
            route_action_on_pass,
        )
        .await;

        if connection_close {
            return;
        }
    }
}

/// One lazily-established upstream HTTP/2 connection, shared (cloned) across all
/// streams of a single client connection so we multiplex onto one upstream
/// connection the way a gRPC channel expects.
type SharedH2Upstream = Arc<Mutex<Option<h2::client::SendRequest<bytes::Bytes>>>>;

/// MITM an HTTP/2 connection (PILOT-245). Accepts each inbound h2 stream and
/// spawns a per-stream task that proxies it to the upstream origin, streaming
/// DATA frames and trailers in both directions (so gRPC keeps working) while
/// teeing a bounded copy of the bodies for the trace.
async fn handle_mitm_h2<C>(
    client_tls: C,
    hostname: String,
    upstream_host: String,
    upstream_port: u16,
    state: Arc<Mutex<ProxyState>>,
) where
    C: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut conn = match h2::server::handshake(client_tls).await {
        Ok(c) => c,
        Err(e) => {
            debug!(%hostname, "h2 server handshake failed: {e}");
            return;
        }
    };

    let hostname = Arc::new(hostname);
    let upstream_host = Arc::new(upstream_host);
    let upstream: SharedH2Upstream = Arc::new(Mutex::new(None));

    // The accept loop IS the connection driver — keep polling it so
    // connection-level frames (WINDOW_UPDATE, PING, GOAWAY) keep flowing while
    // per-stream tasks run. Never block it on per-stream work.
    loop {
        match conn.accept().await {
            Some(Ok((request, respond))) => {
                tokio::spawn(serve_h2_stream(
                    request,
                    respond,
                    hostname.clone(),
                    upstream_host.clone(),
                    upstream_port,
                    state.clone(),
                    upstream.clone(),
                ));
            }
            Some(Err(e)) => {
                debug!(%hostname, "h2 accept error: {e}");
                return;
            }
            None => {
                debug!(%hostname, "h2 connection closed");
                return;
            }
        }
    }
}

/// Proxy a single HTTP/2 stream (one request/response exchange) to the upstream
/// origin. When no `device.route()` matches, the request streams straight
/// through (so bidirectional / server-streaming gRPC doesn't deadlock); when a
/// route matches, the request body is buffered so the handler can mock, abort,
/// or mutate it.
async fn serve_h2_stream(
    request: http::Request<h2::RecvStream>,
    mut respond: h2::server::SendResponse<bytes::Bytes>,
    hostname: Arc<String>,
    upstream_host: Arc<String>,
    upstream_port: u16,
    state: Arc<Mutex<ProxyState>>,
    upstream: SharedH2Upstream,
) {
    let start = now_ms();
    let handler = state.lock().await.handler.clone();

    let (parts, mut client_recv) = request.into_parts();
    let method = parts.method.clone();
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    // Capture host: prefer the :authority pseudo-header (what the app asked
    // for), fall back to the SNI used for the TLS connection.
    let cap_host = parts
        .uri
        .authority()
        .map(|a| a.as_str().to_string())
        .unwrap_or_else(|| (*hostname).clone());
    let req_headers = parsed_headers_from_h2(&parts.headers);

    // Fire the request notification immediately on headers so waitForRequest /
    // device.on('request') work even for never-ending server streams.
    if let Some(h) = handler.as_ref() {
        let notify_req = ParsedRequest {
            method: method.to_string(),
            path: path.clone(),
            headers: req_headers.clone(),
            body: Vec::new(),
            raw_bytes: Vec::new(),
            override_host: None,
        };
        h.notify_request(&notify_req, &cap_host, true).await;
    }

    let url = format!("https://{cap_host}{path}");
    let route_matches = match handler.as_ref() {
        Some(h) => h.matches(&url).await,
        None => false,
    };

    // Request-forwarding plan, possibly adjusted by a matching route below.
    let mut complete_body: Option<Vec<u8>> = None; // Some => forward this buffered body, then end
    let mut stream_prefix: Vec<u8> = Vec::new(); // bytes already read (overflow), sent before streaming
    let mut route_action: &'static str = "";
    let mut up_method = parts.method.clone();
    let mut up_headers = parts.headers.clone();
    let mut record_headers = req_headers.clone();

    if route_matches {
        let handler = handler.as_ref().expect("route_matches implies a handler");
        match buffer_request_body(&mut client_recv, MAX_PROXY_BODY).await {
            Ok((body, true)) => {
                let _ = client_recv.trailers().await;
                let mut req = ParsedRequest {
                    method: method.to_string(),
                    path: path.clone(),
                    headers: req_headers.clone(),
                    body,
                    raw_bytes: Vec::new(),
                    override_host: None,
                };
                match handler.on_request(&mut req, &cap_host, true).await {
                    RequestOutcome::Synthesized(synth) => {
                        write_h2_synthesized(
                            &mut respond,
                            synth,
                            handler,
                            &req,
                            &cap_host,
                            &state,
                            start,
                        )
                        .await;
                        return;
                    }
                    RequestOutcome::Continued => {
                        route_action = "continued";
                        if let Some(origin) = req.override_host.clone() {
                            // Cross-origin continue: fetch the other origin and
                            // relay its (buffered) response back to the client.
                            forward_h2_cross_origin(
                                &mut respond,
                                &origin,
                                &req,
                                &cap_host,
                                handler,
                                &state,
                                start,
                            )
                            .await;
                            return;
                        }
                        up_method = http::Method::from_bytes(req.method.as_bytes())
                            .unwrap_or(method.clone());
                        up_headers = h2_headers_from_parsed(&req.headers);
                        record_headers = req.headers.clone();
                        complete_body = Some(req.body);
                    }
                    RequestOutcome::NotMatched => {
                        complete_body = Some(req.body);
                    }
                }
            }
            Ok((prefix, false)) => {
                // Body exceeds the buffer budget: can't safely run the handler,
                // so forward what we read plus the rest of the stream untouched.
                warn!(
                    %cap_host,
                    "h2 request body exceeds {MAX_PROXY_BODY} bytes on a routed URL; \
                     forwarding without interception"
                );
                stream_prefix = prefix;
            }
            Err(e) => {
                debug!(%cap_host, "h2 request buffering failed: {e}");
                respond.send_reset(h2::Reason::INTERNAL_ERROR);
                return;
            }
        }
    }

    // Establish (or reuse) the upstream h2 connection.
    let send_req = match ensure_h2_upstream(
        &upstream,
        &state,
        &upstream_host,
        upstream_port,
        &hostname,
    )
    .await
    {
        Some(s) => s,
        None => {
            // Upstream didn't negotiate h2 (or connect failed). Reset the
            // stream and leave a breadcrumb mirroring the passthrough one.
            info!(
                %hostname, upstream_port,
                "h2 upstream unavailable (non-h2 origin?) — add the host to networkPassthroughHosts"
            );
            respond.send_reset(h2::Reason::REFUSED_STREAM);
            drain_recv(&mut client_recv).await;
            return;
        }
    };
    let mut send_req = match send_req.ready().await {
        Ok(s) => s,
        Err(e) => {
            debug!(%hostname, "h2 upstream not ready: {e}");
            respond.send_reset(h2::Reason::INTERNAL_ERROR);
            drain_recv(&mut client_recv).await;
            return;
        }
    };

    // Build the upstream request. The URI is absolute (scheme + authority +
    // path) because h2 reconstructs it from the pseudo headers, which is what
    // the client side needs to re-emit them.
    let mut up_req = http::Request::new(());
    *up_req.method_mut() = up_method;
    *up_req.uri_mut() = parts.uri.clone();
    *up_req.version_mut() = http::Version::HTTP_2;
    *up_req.headers_mut() = up_headers;

    // End the stream on the HEADERS frame only when there's definitely no body.
    let empty_complete = matches!(&complete_body, Some(b) if b.is_empty());
    let end_on_headers = empty_complete
        || (complete_body.is_none() && stream_prefix.is_empty() && client_recv.is_end_stream());
    let (resp_fut, up_send) = match send_req.send_request(up_req, end_on_headers) {
        Ok(x) => x,
        Err(e) => {
            debug!(%hostname, "h2 send_request failed: {e}");
            respond.send_reset(h2::Reason::INTERNAL_ERROR);
            drain_recv(&mut client_recv).await;
            return;
        }
    };

    // Request side: send a buffered body, or stream (with any overflow prefix).
    let req_side = async move {
        let mut tee = Vec::new();
        let mut size: u64 = 0;
        let mut up_send = up_send;
        if let Some(body) = complete_body {
            if !body.is_empty() {
                size = body.len() as u64;
                let cap = body.len().min(MAX_BODY_SIZE);
                tee.extend_from_slice(&body[..cap]);
                if let Err(e) = send_owned_body(&mut up_send, body, true).await {
                    debug!("h2 buffered request send error: {e}");
                }
            }
        } else if !end_on_headers {
            if !stream_prefix.is_empty() {
                size += stream_prefix.len() as u64;
                let cap = stream_prefix.len().min(MAX_BODY_SIZE);
                tee.extend_from_slice(&stream_prefix[..cap]);
                if let Err(e) = send_owned_body(&mut up_send, stream_prefix, false).await {
                    debug!("h2 request prefix send error: {e}");
                }
            }
            if let Err(e) = pump_body(&mut client_recv, &mut up_send, &mut tee, &mut size).await {
                debug!("h2 request body pump error: {e}");
            }
        }
        (tee, size)
    };

    // Response side: relay the upstream response (streamed) back to the client.
    let resp_side = forward_h2_response(resp_fut, respond);

    let ((req_tee, req_size), (status_code, resp_headers, resp_tee, resp_size)) =
        tokio::join!(req_side, resp_side);

    // Record the exchange. For never-ending streams this only runs once the
    // stream closes (documented limitation).
    let parsed_req = ParsedRequest {
        method: method.to_string(),
        path,
        headers: record_headers,
        body: req_tee,
        raw_bytes: Vec::new(),
        override_host: None,
    };
    let parsed_resp = ParsedResponse {
        status_code,
        headers: resp_headers,
        body: resp_tee,
        raw_bytes: Vec::new(),
    };
    if let Some(h) = handler.as_ref() {
        h.notify_response(&parsed_req, &parsed_resp, &cap_host, true, route_action)
            .await;
    }
    record_entry_sized(
        &state,
        &parsed_req,
        &parsed_resp,
        &cap_host,
        true,
        start,
        route_action,
        req_size,
        resp_size,
    )
    .await;
}

/// Await the upstream response, relay its head + streamed body + trailers to the
/// client, and return `(status, headers, teed_body, total_size)` for capture.
/// Consumes `respond` (it owns the client send half).
async fn forward_h2_response(
    resp_fut: h2::client::ResponseFuture,
    mut respond: h2::server::SendResponse<bytes::Bytes>,
) -> (i32, Vec<(String, String)>, Vec<u8>, u64) {
    let response = match resp_fut.await {
        Ok(r) => r,
        Err(e) => {
            debug!("h2 upstream response error: {e}");
            respond.send_reset(h2::Reason::INTERNAL_ERROR);
            return (0, Vec::new(), Vec::new(), 0);
        }
    };
    let (rparts, mut up_recv) = response.into_parts();
    let status_code = rparts.status.as_u16() as i32;
    let resp_headers = parsed_headers_from_h2(&rparts.headers);

    let mut client_resp = http::Response::new(());
    *client_resp.status_mut() = rparts.status;
    *client_resp.version_mut() = http::Version::HTTP_2;
    *client_resp.headers_mut() = rparts.headers;

    let mut client_send = match respond.send_response(client_resp, false) {
        Ok(s) => s,
        Err(e) => {
            debug!("h2 send_response to client failed: {e}");
            return (status_code, resp_headers, Vec::new(), 0);
        }
    };
    let mut tee = Vec::new();
    let mut size: u64 = 0;
    if let Err(e) = pump_body(&mut up_recv, &mut client_send, &mut tee, &mut size).await {
        debug!("h2 response body pump error: {e}");
    }
    (status_code, resp_headers, tee, size)
}

/// Write a synthesized response (route `fulfill`/`abort`) to the client h2
/// stream and record it. Never touches the upstream.
async fn write_h2_synthesized(
    respond: &mut h2::server::SendResponse<bytes::Bytes>,
    synth: ParsedResponse,
    handler: &Arc<dyn NetworkHandler>,
    req: &ParsedRequest,
    cap_host: &str,
    state: &Arc<Mutex<ProxyState>>,
    start: u64,
) {
    if synth.status_code == 0 {
        // Abort: reset the stream rather than send a response.
        respond.send_reset(h2::Reason::CANCEL);
        handler
            .notify_response(req, &synth, cap_host, true, "aborted")
            .await;
        record_entry_sized(
            state,
            req,
            &synth,
            cap_host,
            true,
            start,
            "aborted",
            req.body.len() as u64,
            0,
        )
        .await;
        return;
    }

    let status =
        http::StatusCode::from_u16(synth.status_code as u16).unwrap_or(http::StatusCode::OK);
    let mut resp = http::Response::new(());
    *resp.status_mut() = status;
    *resp.version_mut() = http::Version::HTTP_2;
    *resp.headers_mut() = h2_headers_from_parsed(&synth.headers);
    let body = synth.body.clone();
    let end = body.is_empty();
    match respond.send_response(resp, end) {
        Ok(mut send) => {
            if !end {
                let _ = send_owned_body(&mut send, body, true).await;
            }
        }
        Err(e) => debug!("h2 fulfill send_response failed: {e}"),
    }
    handler
        .notify_response(req, &synth, cap_host, true, "mocked")
        .await;
    let resp_size = synth.body.len() as u64;
    record_entry_sized(
        state,
        req,
        &synth,
        cap_host,
        true,
        start,
        "mocked",
        req.body.len() as u64,
        resp_size,
    )
    .await;
}

/// Handle a `route.continue({ url })` that redirects to a different origin: use
/// the version-agnostic `fetch_upstream` helper and relay its buffered response.
async fn forward_h2_cross_origin(
    respond: &mut h2::server::SendResponse<bytes::Bytes>,
    origin: &OverrideOrigin,
    req: &ParsedRequest,
    cap_host: &str,
    handler: &Arc<dyn NetworkHandler>,
    state: &Arc<Mutex<ProxyState>>,
    start: u64,
) {
    let url = origin.url(&req.path);
    match crate::route_handler::fetch_upstream(&url, &req.method, &req.headers, &req.body).await {
        Some(resp) => {
            let status = http::StatusCode::from_u16(resp.status_code as u16)
                .unwrap_or(http::StatusCode::BAD_GATEWAY);
            let mut hresp = http::Response::new(());
            *hresp.status_mut() = status;
            *hresp.version_mut() = http::Version::HTTP_2;
            *hresp.headers_mut() = h2_headers_from_parsed(&resp.headers);
            let body = resp.body.clone();
            let end = body.is_empty();
            match respond.send_response(hresp, end) {
                Ok(mut send) => {
                    if !end {
                        let _ = send_owned_body(&mut send, body, true).await;
                    }
                }
                Err(e) => debug!("h2 cross-origin send_response failed: {e}"),
            }
            handler
                .notify_response(req, &resp, cap_host, true, "continued")
                .await;
            let resp_size = resp.body.len() as u64;
            record_entry_sized(
                state,
                req,
                &resp,
                cap_host,
                true,
                start,
                "continued",
                req.body.len() as u64,
                resp_size,
            )
            .await;
        }
        None => respond.send_reset(h2::Reason::INTERNAL_ERROR),
    }
}

/// Buffer a request body up to `cap` bytes. Returns `(bytes, complete)` where
/// `complete` is false if the body overflowed `cap` (more may remain on
/// `recv`). Flow control is released as data is consumed.
async fn buffer_request_body(
    recv: &mut h2::RecvStream,
    cap: usize,
) -> Result<(Vec<u8>, bool), h2::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = recv.data().await {
        let chunk = chunk?;
        recv.flow_control().release_capacity(chunk.len())?;
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Ok((body, false));
        }
    }
    Ok((body, true))
}

/// Send an owned buffer over an h2 `SendStream` in send-window-sized pieces,
/// setting END_STREAM on the final frame when `end` is true.
async fn send_owned_body(
    send: &mut h2::SendStream<bytes::Bytes>,
    data: Vec<u8>,
    end: bool,
) -> Result<(), h2::Error> {
    if data.is_empty() {
        if end {
            send.send_data(bytes::Bytes::new(), true)?;
        }
        return Ok(());
    }
    let mut buf = bytes::Bytes::from(data);
    while !buf.is_empty() {
        send.reserve_capacity(buf.len());
        while send.capacity() == 0 {
            match std::future::poll_fn(|cx| send.poll_capacity(cx)).await {
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e),
                None => return Ok(()),
            }
        }
        let take = send.capacity().min(buf.len());
        let piece = buf.split_to(take);
        let last = end && buf.is_empty();
        send.send_data(piece, last)?;
    }
    Ok(())
}

/// Build an h2 `HeaderMap` from the proxy's `(name, value)` pairs, dropping the
/// hop-by-hop / framing headers HTTP/2 forbids or manages itself (so a
/// `fulfill`/`continue` from the SDK can't produce an illegal frame).
fn h2_headers_from_parsed(headers: &[(String, String)]) -> http::HeaderMap {
    const SKIP: [&str; 7] = [
        "connection",
        "proxy-connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "host",
    ];
    let mut map = http::HeaderMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if SKIP.contains(&lower.as_str()) {
            continue;
        }
        // `te` is only legal in h2 with the value "trailers".
        if lower == "te" && !value.eq_ignore_ascii_case("trailers") {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            http::HeaderName::from_bytes(name.as_bytes()),
            http::HeaderValue::from_str(value),
        ) {
            map.append(n, v);
        }
    }
    map
}

/// Copy DATA frames and trailers from `recv` to `send`, threading flow control
/// (release receive capacity as consumed, await send capacity before writing)
/// and teeing up to `MAX_BODY_SIZE` bytes into `tee` while counting the true
/// total in `total`.
async fn pump_body(
    recv: &mut h2::RecvStream,
    send: &mut h2::SendStream<bytes::Bytes>,
    tee: &mut Vec<u8>,
    total: &mut u64,
) -> Result<(), h2::Error> {
    while let Some(chunk) = recv.data().await {
        let mut chunk = chunk?;
        let len = chunk.len();
        *total += len as u64;
        if tee.len() < MAX_BODY_SIZE {
            let take = (MAX_BODY_SIZE - tee.len()).min(len);
            tee.extend_from_slice(&chunk[..take]);
        }
        // Forward the chunk in send-window-sized pieces. Sending only what the
        // downstream window currently allows (rather than waiting for the whole
        // chunk's worth of capacity) keeps data flowing — waiting for a full
        // 64 KiB of capacity would deadlock against the 65 535-byte initial
        // window, since no data would flow to trigger a WINDOW_UPDATE.
        while !chunk.is_empty() {
            send.reserve_capacity(chunk.len());
            while send.capacity() == 0 {
                match std::future::poll_fn(|cx| send.poll_capacity(cx)).await {
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e),
                    None => return Ok(()), // downstream closed; stop
                }
            }
            let take = send.capacity().min(chunk.len());
            let piece = chunk.split_to(take);
            send.send_data(piece, false)?;
        }
        // Release receive capacity only after queuing downstream, so client
        // backpressure tracks the downstream window.
        recv.flow_control().release_capacity(len)?;
    }
    // After DATA drains, forward trailers (grpc-status/grpc-message live here)
    // or end the stream cleanly with an empty final frame.
    match recv.trailers().await? {
        Some(trailers) => send.send_trailers(trailers)?,
        None => send.send_data(bytes::Bytes::new(), true)?,
    }
    Ok(())
}

/// Get (or lazily establish) the shared upstream h2 connection for this client
/// connection, returning a fresh `SendRequest` handle for a new stream.
async fn ensure_h2_upstream(
    upstream: &SharedH2Upstream,
    state: &Arc<Mutex<ProxyState>>,
    upstream_host: &str,
    upstream_port: u16,
    sni: &str,
) -> Option<h2::client::SendRequest<bytes::Bytes>> {
    let mut guard = upstream.lock().await;
    if let Some(sr) = guard.as_ref() {
        return Some(sr.clone());
    }
    let sr = connect_h2_upstream(state, upstream_host, upstream_port, sni).await?;
    *guard = Some(sr.clone());
    Some(sr)
}

/// Dial the upstream origin over TLS with an `h2`-preferring ALPN and complete
/// the HTTP/2 client handshake. Returns `None` if the origin doesn't speak h2
/// (caller resets the stream) or the connection fails. The connection driver
/// future is spawned so frames keep flowing.
async fn connect_h2_upstream(
    state: &Arc<Mutex<ProxyState>>,
    upstream_host: &str,
    upstream_port: u16,
    server_name_host: &str,
) -> Option<h2::client::SendRequest<bytes::Bytes>> {
    let addr = join_host_port(upstream_host, upstream_port);
    let tcp = match tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            debug!("h2 upstream connect failed to {addr}: {e}");
            return None;
        }
        Err(_) => {
            debug!("h2 upstream connect timed out to {addr}");
            return None;
        }
    };

    let cfg = state.lock().await.h2_client_config.clone();
    let server_name = match rustls::pki_types::ServerName::try_from(server_name_host.to_string()) {
        Ok(sn) => sn,
        Err(e) => {
            debug!("Invalid upstream server name '{server_name_host}': {e}");
            return None;
        }
    };
    let tls = match TlsConnector::from(cfg).connect(server_name, tcp).await {
        Ok(s) => s,
        Err(e) => {
            debug!("h2 upstream TLS handshake with {server_name_host} failed: {e}");
            return None;
        }
    };
    if tls.get_ref().1.alpn_protocol() != Some(b"h2") {
        debug!(%server_name_host, "upstream did not negotiate h2");
        return None;
    }

    let (send_req, connection) = match h2::client::handshake(tls).await {
        Ok(x) => x,
        Err(e) => {
            debug!("h2 upstream handshake failed for {server_name_host}: {e}");
            return None;
        }
    };
    // Drive the connection — without this nothing flows.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            debug!("h2 upstream connection driver ended: {e}");
        }
    });
    Some(send_req)
}

/// Drain and discard a client request body (releasing flow control) so a reset
/// stream doesn't sit on the connection's flow window.
async fn drain_recv(recv: &mut h2::RecvStream) {
    while let Some(Ok(chunk)) = recv.data().await {
        let _ = recv.flow_control().release_capacity(chunk.len());
    }
    let _ = recv.trailers().await;
}

/// Convert an h2/http `HeaderMap` into the proxy's `Vec<(name, value)>` form.
/// Pseudo-headers (`:method` etc.) are never present in a `HeaderMap` — they
/// live in the request/response head — so no filtering is needed.
fn parsed_headers_from_h2(headers: &http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
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
        override_host: None,
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
            // (rare in Tapsmith's mobile-test use case — ordinary URLSession /
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
pub(crate) fn is_valid_header_name(name: &str) -> bool {
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
pub(crate) fn write_header_sanitised(out: &mut Vec<u8>, name: &str, value: &str) {
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
pub(crate) fn sanitise_request_line_component(s: &str) -> Vec<u8> {
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
    route_action: &str,
) {
    // The HTTP/1.1 path buffers full bodies, so body length is the true size.
    let request_size = req.body.len() as u64;
    let response_size = resp.body.len() as u64;
    record_entry_sized(
        state,
        req,
        resp,
        hostname,
        is_https,
        start_ms,
        route_action,
        request_size,
        response_size,
    )
    .await;
}

/// Like [`record_entry`] but with explicit transferred byte counts. The HTTP/2
/// path streams bodies and only tees a truncated copy (`req.body`/`resp.body`)
/// for the trace, so it can't derive the true size from the buffered body —
/// it tracks the real totals separately and passes them here.
#[allow(clippy::too_many_arguments)]
async fn record_entry_sized(
    state: &Arc<Mutex<ProxyState>>,
    req: &ParsedRequest,
    resp: &ParsedResponse,
    hostname: &str,
    is_https: bool,
    start_ms: u64,
    route_action: &str,
    request_size: u64,
    response_size: u64,
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
        request_size,
        response_size,
        start_time_ms: start_ms,
        duration_ms: duration,
        request_headers: req.headers.clone(),
        response_headers: resp.headers.clone(),
        request_body: truncate(&req.body),
        response_body: truncate(&resp.body),
        is_https,
        route_action: route_action.to_string(),
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
    loop {
        // Re-read the handler on each request so that routes registered after
        // this connection was established are visible immediately. The lock +
        // Arc::clone is cheap compared to the network I/O per request.
        let handler = state.lock().await.handler.clone();
        let start = now_ms();

        let mut req = match read_request(&mut client_stream, hostname).await {
            ReadOutcome::Ok(r) => r,
            ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
        };

        // Fire a request event to any SDK subscribers BEFORE interception
        // runs — mirrors Playwright's `page.on('request')` timing and means
        // `waitForRequest` resolves as soon as the proxy sees bytes.
        if let Some(h) = handler.as_ref() {
            h.notify_request(&req, hostname, is_https).await;
        }

        // Request hook: optionally transform the request, and optionally
        // short-circuit with a synthetic response (no upstream call at all).
        // After the hook runs we re-serialize `raw_bytes` from the (possibly
        // mutated) structured fields so the upstream write below sees the
        // new shape. The synthetic-response branch never forwards upstream,
        // so we skip the re-encode there — it's wasted work (`record_entry`
        // reads structured fields, not `raw_bytes`).
        //
        // The outcome drives `route_action` on the pass-through record_entry
        // below — "continued" for matched+continue, "" for passthrough.
        let mut route_action_on_pass: &'static str = "";
        if let Some(h) = handler.as_ref() {
            match h.on_request(&mut req, hostname, is_https).await {
                RequestOutcome::Synthesized(mut synth) => {
                    if synth.status_code == 0 {
                        // Abort: drop the connection without writing anything.
                        // A clean TCP close triggers a network error in the app's
                        // HTTP client without corrupting its state (important for
                        // iOS NSURLSession which crashes on malformed responses).
                        h.notify_response(&req, &synth, hostname, is_https, "aborted")
                            .await;
                        record_entry(&state, &req, &synth, hostname, is_https, start, "aborted")
                            .await;
                        return;
                    }
                    if synth.raw_bytes.is_empty() {
                        synth.raw_bytes = reencode_response(&synth);
                    }
                    if client_stream.write_all(&synth.raw_bytes).await.is_err() {
                        return;
                    }
                    let close = has_connection_close(&synth.headers);
                    h.notify_response(&req, &synth, hostname, is_https, "mocked")
                        .await;
                    record_entry(&state, &req, &synth, hostname, is_https, start, "mocked").await;
                    if close {
                        return;
                    }
                    continue;
                }
                RequestOutcome::Continued => {
                    // Handler may have mutated `req`, so reserialize before
                    // forwarding upstream.
                    req.raw_bytes = reencode_request(&req);
                    route_action_on_pass = "continued";
                }
                RequestOutcome::NotMatched => {
                    // No route matched — forward untouched, leave action empty.
                }
            }
        }

        // When cross-origin, use the override values for logging/events.
        let (effective_hostname, effective_is_https) = match req.override_host {
            Some(ref origin) => (origin.host.clone(), origin.is_https),
            None => (hostname.to_string(), is_https),
        };

        let mut resp = if let Some(ref origin) = req.override_host {
            let url = origin.url(&req.path);
            match crate::route_handler::fetch_upstream(&url, &req.method, &req.headers, &req.body)
                .await
            {
                Some(r) => r,
                None => {
                    let _ = client_stream
                        .write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                        .await;
                    return;
                }
            }
        } else {
            if upstream_stream.write_all(&req.raw_bytes).await.is_err() {
                return;
            }
            match read_response(&mut upstream_stream, hostname).await {
                ReadOutcome::Ok(r) => r,
                ReadOutcome::ConnectionClosed | ReadOutcome::Error => return,
            }
        };

        if let Some(h) = handler.as_ref() {
            h.on_response(&req, &effective_hostname, effective_is_https, &mut resp)
                .await;
            resp.raw_bytes = reencode_response(&resp);
        }

        if client_stream.write_all(&resp.raw_bytes).await.is_err() {
            return;
        }

        let connection_close = has_connection_close(&resp.headers);

        if let Some(h) = handler.as_ref() {
            h.notify_response(
                &req,
                &resp,
                &effective_hostname,
                effective_is_https,
                route_action_on_pass,
            )
            .await;
        }
        record_entry(
            &state,
            &req,
            &resp,
            &effective_hostname,
            effective_is_https,
            start,
            route_action_on_pass,
        )
        .await;

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
    let (mut req_headers, header_end) = parse_headers(initial_data);
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

    // Owned copies of method/path that the handler can mutate via
    // route.continue() overrides. Shadowed below after the handler block.
    let mut effective_method = method.to_string();
    let mut effective_path = path.clone();
    let mut was_continued = false;
    let mut hostname_owned = host.split(':').next().unwrap_or(&host).to_string();

    // Check handler for route interception before forwarding upstream.
    let handler = state.lock().await.handler.clone();
    if let Some(h) = handler.as_ref() {
        let mut parsed_req = ParsedRequest {
            method: effective_method.clone(),
            path: effective_path.clone(),
            headers: req_headers.clone(),
            body: request_body.clone(),
            raw_bytes: Vec::new(),
            override_host: None,
        };
        let hostname = hostname_owned.as_str();

        // Fire `request` event before interception runs so waitForRequest /
        // device.on('request') see the pre-mutation request.
        h.notify_request(&parsed_req, hostname, false).await;

        match h.on_request(&mut parsed_req, hostname, false).await {
            RequestOutcome::Synthesized(mut synth) => {
                if synth.status_code == 0 {
                    // Abort: drop the connection without sending anything.
                    // This causes a clean TCP RST / connection-closed error in
                    // the app's HTTP client rather than a malformed response
                    // that could crash iOS's NSURLSession.
                    h.notify_response(&parsed_req, &synth, hostname, false, "aborted")
                        .await;
                    record_entry(
                        &state,
                        &parsed_req,
                        &synth,
                        hostname,
                        false,
                        start,
                        "aborted",
                    )
                    .await;
                    return;
                }
                // Handler returned a synthetic response — send it to the client.
                if synth.raw_bytes.is_empty() {
                    synth.raw_bytes = reencode_response(&synth);
                }
                let _ = client.write_all(&synth.raw_bytes).await;
                h.notify_response(&parsed_req, &synth, hostname, false, "mocked")
                    .await;
                record_entry(
                    &state,
                    &parsed_req,
                    &synth,
                    hostname,
                    false,
                    start,
                    "mocked",
                )
                .await;
                return;
            }
            RequestOutcome::Continued => {
                was_continued = true;
                effective_method = parsed_req.method;
                effective_path = parsed_req.path;
                req_headers = parsed_req.headers;
                request_body = parsed_req.body;
                if let Some(ref origin) = parsed_req.override_host {
                    // Cross-origin: use fetch_upstream which handles both
                    // HTTP and HTTPS targets correctly.
                    let url = origin.url(&effective_path);
                    let resp = match crate::route_handler::fetch_upstream(
                        &url,
                        &effective_method,
                        &req_headers,
                        &request_body,
                    )
                    .await
                    {
                        Some(r) => r,
                        None => {
                            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                            return;
                        }
                    };
                    let raw = reencode_response(&resp);
                    let _ = client.write_all(&raw).await;
                    hostname_owned = origin.host.clone();
                    let notify_req = ParsedRequest {
                        method: effective_method,
                        path: effective_path,
                        headers: req_headers,
                        body: request_body,
                        raw_bytes: Vec::new(),
                        override_host: None,
                    };
                    if let Some(h) = handler.as_ref() {
                        h.notify_response(
                            &notify_req,
                            &resp,
                            &hostname_owned,
                            origin.is_https,
                            "continued",
                        )
                        .await;
                    }
                    record_entry(
                        &state,
                        &notify_req,
                        &resp,
                        &hostname_owned,
                        origin.is_https,
                        start,
                        "continued",
                    )
                    .await;
                    return;
                }
            }
            RequestOutcome::NotMatched => {
                // No registered route matched this URL — forward original.
            }
        }
    }

    // Rebuild the request with a relative path for the upstream server
    let method = &effective_method;
    let path = &effective_path;
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
                route_action: String::new(),
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

    // Fire `response` event if a route handler is installed + events are
    // subscribed. `route_action` mirrors what we record in `CapturedEntry`.
    if let Some(h) = handler.as_ref() {
        let route_action = if was_continued { "continued" } else { "" };
        let notify_req = ParsedRequest {
            method: effective_method.clone(),
            path: effective_path.clone(),
            headers: req_headers.clone(),
            body: request_body.clone(),
            raw_bytes: Vec::new(),
            override_host: None,
        };
        let notify_resp = ParsedResponse {
            status_code,
            headers: resp_headers.clone(),
            body: response_body.clone(),
            raw_bytes: Vec::new(),
        };
        h.notify_response(
            &notify_req,
            &notify_resp,
            &hostname_owned,
            false,
            route_action,
        )
        .await;
    }

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
        route_action: if was_continued {
            "continued".to_string()
        } else {
            String::new()
        },
    });
}

// ─── Transparent-TCP entry point ───
//
// Used by the `ios_redirect` module (macOS) and iptables-redirected
// connections (Android) to feed already-accepted client streams into the
// MITM pipeline without a CONNECT preamble. Also used by
// `handle_connection` when it detects a raw TLS ClientHello instead of
// an HTTP request line.

/// A stream adapter that reads from a pre-captured prefix buffer first,
/// then delegates to an inner stream. Used by [`handle_transparent_tcp`] to
/// "un-peek" the first bytes read during TLS/HTTP detection.
struct PrefixedStream<S> {
    prefix: Vec<u8>,
    prefix_pos: usize,
    inner: S,
}

impl<S> PrefixedStream<S> {
    fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            prefix_pos: 0,
            inner,
        }
    }
}

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
async fn dial_upstream(dst_host: &str, dst_port: u16) -> Option<TcpStream> {
    let addr = join_host_port(dst_host, dst_port);
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
/// `0x40`). If the prefix matches, [`handle_transparent_tls`] parses the
/// client's `ClientHello`, extracts the **real hostname from the SNI
/// extension** (upstream `ServerName` + per-host MITM cert CN), and decides
/// between MITM interception and end-to-end passthrough (PILOT-231). Plain
/// HTTP flows pass through to [`handle_mitm_http`] directly (no SNI needed).
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

/// Result of reading a TLS `ClientHello` off a client stream while recording
/// every byte read, so the connection can either be MITM'd (replay the
/// recorded bytes into a [`tokio_rustls::LazyConfigAcceptor`] via
/// [`PrefixedStream`]) or tunneled upstream untouched (replay the recorded
/// bytes to the origin).
struct ClientHelloInfo {
    /// Every byte read from the client so far. May extend past the end of
    /// the ClientHello if the client pipelined data into the same read;
    /// replaying the whole buffer preserves fidelity in both the MITM and
    /// tunnel cases.
    recorded: Vec<u8>,
    sni: Option<String>,
    /// ALPN protocols offered by the client, in client preference order.
    /// Empty when the client sent no ALPN extension.
    alpn: Vec<Vec<u8>>,
}

/// Upper bound on bytes buffered while waiting for a complete ClientHello.
/// A TLS record is at most ~16 KiB; even a multi-record hello fits well
/// under this. Anything larger is not a ClientHello.
const MAX_CLIENT_HELLO_SIZE: usize = 65536;

/// Read a complete TLS `ClientHello` from `stream`, recording the raw bytes
/// consumed. Drives [`rustls::server::Acceptor`] manually because
/// `tokio_rustls::StartHandshake` cannot return the underlying IO — and we
/// must be able to hand the untouched byte stream to a passthrough tunnel.
async fn read_client_hello<S>(stream: &mut S) -> std::io::Result<ClientHelloInfo>
where
    S: AsyncRead + Unpin,
{
    let mut acceptor = rustls::server::Acceptor::default();
    let mut recorded = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "client closed before completing ClientHello",
            ));
        }
        recorded.extend_from_slice(&chunk[..n]);
        if recorded.len() > MAX_CLIENT_HELLO_SIZE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "TLS ClientHello exceeds maximum size",
            ));
        }
        // Feed the entire chunk to the acceptor. `read_tls` may not consume
        // the whole slice in one call, so loop until it has.
        let mut cursor: &[u8] = &chunk[..n];
        while !cursor.is_empty() {
            let consumed = acceptor.read_tls(&mut cursor)?;
            if consumed == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "TLS acceptor refused ClientHello bytes",
                ));
            }
            match acceptor.accept() {
                Ok(Some(accepted)) => {
                    let hello = accepted.client_hello();
                    let sni = hello.server_name().map(|s| s.to_string());
                    let alpn = hello
                        .alpn()
                        .map(|it| it.map(|p| p.to_vec()).collect())
                        .unwrap_or_default();
                    return Ok(ClientHelloInfo {
                        recorded,
                        sni,
                        alpn,
                    });
                }
                Ok(None) => {} // need more bytes
                Err((e, _alert)) => {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, e));
                }
            }
        }
    }
}

/// Whether a connection must bypass MITM based on the client's ALPN offer.
///
/// True when the client offers ALPN but no HTTP/1.x variant.
/// The MITM engine speaks both HTTP/1.1 and HTTP/2 (PILOT-245), so a client
/// only needs to be tunneled when it offers an ALPN list with *no* protocol
/// we can speak. No ALPN at all means a plain HTTPS client — MITM as HTTP/1.1.
/// `["h2"]` (gRPC-Core/BoringSSL: Firestore, gRPC APIs) and any list
/// containing `http/1.1`/`http/1.0`/`h2` are MITM'd. Exotic ALPN-only
/// protocols (`grpc-exp` with no h2, custom) are still passed through: MITM
/// would break them anyway, so tunneling is strictly better.
fn requires_tls_passthrough(alpn: &[Vec<u8>]) -> bool {
    !alpn.is_empty()
        && !alpn
            .iter()
            .any(|p| matches!(p.as_slice(), b"http/1.1" | b"http/1.0" | b"h2"))
}

/// Compile a host glob into an anchored, case-insensitive regex, mirroring
/// the SDK's `trace/filter-hosts.ts` semantics: `*` matches any run of
/// characters, and a leading `*.` (or `**.`) prefix is optional so
/// `*.example.com` matches both `api.example.com` and `example.com` itself.
/// Returns `None` for patterns the regex engine rejects (pathological size).
///
/// Compiled once per pattern in [`NetworkProxy::set_passthrough_hosts`] —
/// per-connection matching only runs the pre-compiled regexes.
fn compile_host_glob(pattern: &str) -> Option<regex::Regex> {
    let pattern = pattern.to_lowercase();
    let (optional_subdomain, body) = match pattern
        .strip_prefix("**.")
        .or_else(|| pattern.strip_prefix("*."))
    {
        Some(tail) => (true, tail),
        None => (false, pattern.as_str()),
    };
    let mut re = String::from("(?i)^");
    if optional_subdomain {
        re.push_str("(?:.*\\.)?");
    }
    for ch in body.chars() {
        if ch == '*' {
            re.push_str(".*");
        } else {
            re.push_str(&regex::escape(&ch.to_string()));
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// Single-pattern convenience over [`compile_host_glob`] (tests and
/// one-off checks; hot paths use the pre-compiled list in `ProxyState`).
#[cfg(test)]
fn host_glob_matches(pattern: &str, host: &str) -> bool {
    compile_host_glob(pattern).is_some_and(|r| r.is_match(host))
}

/// Record a marker entry for a connection tunneled without MITM, so the
/// trace explains *why* expected traffic (gRPC/Firestore, cert-pinned
/// hosts) is absent rather than silently omitting it. One entry per
/// connection, not per request — the proxy never sees the encrypted
/// requests inside the tunnel.
async fn record_passthrough_entry(state: &Arc<Mutex<ProxyState>>, host: &str, port: u16) {
    let url = if port == 443 {
        format!("https://{host}/")
    } else {
        format!("https://{host}:{port}/")
    };
    state.lock().await.entries.push(CapturedEntry {
        method: "CONNECT".to_string(),
        url,
        status_code: 0,
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
        route_action: "passthrough".to_string(),
    });
}

/// End-to-end TLS tunnel for connections we must not MITM (h2-only ALPN or
/// configured passthrough hosts). Replays the already-consumed ClientHello
/// bytes to the origin, then splices the two sockets until either side
/// closes. No capture is possible — the proxy never sees plaintext. No idle
/// timeout either: gRPC streams are long-lived by design, matching the
/// kept-alive MITM loop's lifecycle.
async fn tunnel_tls_passthrough<S>(
    mut client: S,
    recorded: Vec<u8>,
    upstream_host: &str,
    upstream_port: u16,
    sni: &str,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Some(mut upstream) = dial_upstream(upstream_host, upstream_port).await else {
        return; // dial_upstream already logged
    };
    if let Err(e) = upstream.write_all(&recorded).await {
        debug!(%sni, upstream_host, upstream_port, "passthrough: replaying ClientHello failed: {e}");
        return;
    }
    match tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
        Ok((tx, rx)) => {
            debug!(%sni, upstream_host, upstream_port, tx, rx, "passthrough tunnel closed")
        }
        Err(e) => debug!(%sni, upstream_host, upstream_port, "passthrough tunnel error: {e}"),
    }
}

/// Read the client's TLS `ClientHello` and decide how to handle the
/// connection:
///
/// * **Passthrough** — if the client's ALPN offer has no HTTP/1.x variant
///   (h2-only gRPC clients, see [`requires_tls_passthrough`]) or the SNI
///   matches `trace.networkPassthroughHosts`, tunnel the raw TLS bytes to
///   the origin untouched. The app does end-to-end TLS with the real
///   server; nothing is captured for that connection (PILOT-231).
/// * **MITM** — otherwise, extract the SNI, mint a matching cert, complete
///   the client handshake, dial upstream with the real hostname as SNI, and
///   hand both decrypted streams to the HTTP/1.1 capture loop.
///
/// This is the single decision point shared by all three entry paths:
/// Android iptables transparent redirect ([`handle_connection`]), iOS
/// Network Extension redirect ([`handle_transparent_tcp`]), and
/// forward-proxy CONNECT ([`handle_connect`]).
async fn handle_transparent_tls<S>(
    mut client: S,
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
    let hello =
        match tokio::time::timeout(CLIENT_READ_TIMEOUT, read_client_hello(&mut client)).await {
            Ok(Ok(h)) => h,
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
    let sni = hello.sni.clone().unwrap_or_else(|| dst_host.clone());
    debug!(
        %dst_host, dst_port, %sni,
        "transparent TLS: extracted SNI from ClientHello"
    );

    // For transparent redirect (iptables), `dst_host` may be empty — use the
    // SNI hostname for the upstream connection. For iOS NE redirect, `dst_host`
    // is the already-resolved IP which avoids an extra DNS lookup.
    let upstream_host = if dst_host.is_empty() { &sni } else { &dst_host };
    if upstream_host.is_empty() {
        debug!(
            dst_port,
            "transparent TLS: no SNI and no dst_host — cannot determine upstream, dropping"
        );
        return;
    }

    let host_passthrough = state
        .lock()
        .await
        .passthrough_hosts
        .iter()
        .any(|re| re.is_match(&sni));
    if requires_tls_passthrough(&hello.alpn) || host_passthrough {
        // info-level on purpose: this is the breadcrumb a user has when
        // wondering why expected traffic is missing from the capture.
        info!(
            %sni, %upstream_host, dst_port,
            alpn = ?hello
                .alpn
                .iter()
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect::<Vec<_>>(),
            host_rule = host_passthrough,
            "TLS connection tunneled without capture (h2-only ALPN or passthrough host)"
        );
        record_passthrough_entry(&state, &sni, dst_port).await;
        tunnel_tls_passthrough(client, hello.recorded, upstream_host, dst_port, &sni).await;
        return;
    }

    // MITM path: replay the recorded ClientHello bytes so the acceptor flow
    // below sees a byte-identical stream (the re-parse cost is negligible —
    // a ClientHello is at most a few KiB).
    let replay = PrefixedStream::new(hello.recorded, client);
    let start = match tokio::time::timeout(
        CLIENT_READ_TIMEOUT,
        tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), replay),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            debug!(%dst_host, dst_port, "failed re-parsing TLS ClientHello: {e}");
            return;
        }
        Err(_) => {
            debug!(%dst_host, dst_port, "timed out re-parsing TLS ClientHello");
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

    // Dispatch on the protocol negotiated during the handshake. If the client
    // picked h2, frame the connection as HTTP/2 (PILOT-245); otherwise (http/1.1
    // or no ALPN) use the HTTP/1.1 pipeline.
    let negotiated_h2 = client_tls.get_ref().1.alpn_protocol() == Some(b"h2");
    if negotiated_h2 {
        handle_mitm_h2(
            client_tls,
            sni.clone(),
            upstream_host.to_string(),
            dst_port,
            state,
        )
        .await;
    } else {
        handle_mitm_https_lazy_upstream(client_tls, &sni, upstream_host, dst_port, state).await;
    }
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
pub(crate) fn parse_headers(raw: &[u8]) -> (Vec<(String, String)>, usize) {
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
pub(crate) fn parse_status_code(raw: &[u8]) -> i32 {
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
            override_host: None,
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
            override_host: None,
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
            override_host: None,
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
        // Note: in Tapsmith's use case (mobile-test MITM proxy, URLSession /
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

    struct SyntheticHttpsHandler {
        seen_tx: tokio::sync::mpsc::UnboundedSender<String>,
    }

    #[async_trait::async_trait]
    impl NetworkHandler for SyntheticHttpsHandler {
        async fn matches(&self, _url: &str) -> bool {
            true
        }

        async fn notify_request(&self, req: &ParsedRequest, hostname: &str, is_https: bool) {
            let scheme = if is_https { "https" } else { "http" };
            let _ = self
                .seen_tx
                .send(format!("{scheme}://{hostname}{}", req.path));
        }

        async fn on_request(
            &self,
            _req: &mut ParsedRequest,
            _hostname: &str,
            _is_https: bool,
        ) -> RequestOutcome {
            RequestOutcome::Synthesized(ParsedResponse {
                status_code: 200,
                headers: vec![
                    ("Content-Type".to_string(), "application/json".to_string()),
                    ("Content-Length".to_string(), "11".to_string()),
                    ("Connection".to_string(), "close".to_string()),
                ],
                body: br#"{"ok":true}"#.to_vec(),
                raw_bytes: Vec::new(),
            })
        }
    }

    /// Test handler that aborts every matched request.
    struct AbortHandler;

    #[async_trait::async_trait]
    impl NetworkHandler for AbortHandler {
        async fn matches(&self, _url: &str) -> bool {
            true
        }
        async fn on_request(
            &self,
            _req: &mut ParsedRequest,
            _hostname: &str,
            _is_https: bool,
        ) -> RequestOutcome {
            RequestOutcome::Synthesized(ParsedResponse {
                status_code: 0,
                headers: Vec::new(),
                body: Vec::new(),
                raw_bytes: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn https_route_fulfill_does_not_require_upstream_connect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let mut root_store = rustls::RootCertStore::empty();
        let ca_pem = std::fs::read(ca.ca_pem_path()).unwrap();
        let mut reader = std::io::BufReader::new(ca_pem.as_slice());
        for cert in rustls_pemfile::certs(&mut reader) {
            root_store.add(cert.unwrap()).unwrap();
        }
        let client_config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );

        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config: client_config.clone(),
            h2_client_config: client_config.clone(),
            handler: Some(Arc::new(SyntheticHttpsHandler { seen_tx })),
            network_hosts: Vec::new(),
            passthrough_hosts: Vec::new(),
        }));

        let (client_side, server_side) = tokio::io::duplex(65536);
        let server_state = state.clone();
        let server_ca = ca.clone();
        let server = tokio::spawn(async move {
            let server_config = server_ca
                .server_config_for_host("example.test")
                .await
                .unwrap();
            let client_tls = tokio_rustls::LazyConfigAcceptor::new(
                rustls::server::Acceptor::default(),
                server_side,
            )
            .await
            .unwrap()
            .into_stream(server_config)
            .await
            .unwrap();
            handle_mitm_https_lazy_upstream(
                client_tls,
                "example.test",
                "192.0.2.1",
                443,
                server_state,
            )
            .await;
        });

        let server_name =
            rustls::pki_types::ServerName::try_from("example.test".to_string()).unwrap();
        let mut client_tls = TlsConnector::from(client_config)
            .connect(server_name, client_side)
            .await
            .unwrap();
        client_tls
            .write_all(b"GET /users/1 HTTP/1.1\r\nHost: example.test\r\n\r\n")
            .await
            .unwrap();

        let seen = tokio::time::timeout(std::time::Duration::from_secs(2), seen_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(seen, "https://example.test/users/1");

        let mut response = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(2), client_tls.read(&mut buf))
                .await
                .unwrap()
            {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);
                    if response.windows(11).any(|w| w == br#"{"ok":true}"#) {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => panic!("client read failed: {e}"),
            }
        }
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains(r#"{"ok":true}"#));

        server.await.unwrap();
        let entries = state.lock().await.entries.clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://example.test/users/1");
        assert_eq!(entries[0].status_code, 200);
        assert_eq!(entries[0].route_action, "mocked");
    }

    #[tokio::test]
    async fn drain_entries_returns_and_clears_without_stopping_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );
        let proxy = NetworkProxy::start(ca).await.unwrap();
        let port = proxy.port();

        proxy.state.lock().await.entries.push(CapturedEntry {
            method: "GET".to_string(),
            url: "https://example.test/users/1".to_string(),
            status_code: 200,
            content_type: "application/json".to_string(),
            request_size: 0,
            response_size: 2,
            start_time_ms: 1,
            duration_ms: 2,
            request_headers: Vec::new(),
            response_headers: Vec::new(),
            request_body: Vec::new(),
            response_body: b"{}".to_vec(),
            is_https: true,
            route_action: String::new(),
        });

        let entries = proxy.drain_entries().await;

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://example.test/users/1");
        assert!(proxy.state.lock().await.entries.is_empty());
        assert_eq!(proxy.port(), port);

        let remaining = proxy.stop().await;
        assert!(remaining.is_empty());
    }

    #[test]
    fn parse_host_header_with_port() {
        let (host, port) = super::parse_host_header("192.168.4.38:9037").unwrap();
        assert_eq!(host, "192.168.4.38");
        assert_eq!(port, 9037);
    }

    #[test]
    fn parse_host_header_without_port_defaults_to_80() {
        let (host, port) = super::parse_host_header("192.168.4.38").unwrap();
        assert_eq!(host, "192.168.4.38");
        assert_eq!(port, 80);
    }

    #[test]
    fn parse_host_header_empty_returns_none() {
        assert!(super::parse_host_header("").is_none());
        assert!(super::parse_host_header("   ").is_none());
    }

    #[test]
    fn parse_host_header_invalid_port_returns_none() {
        assert!(super::parse_host_header("192.168.4.38:notaport").is_none());
        assert!(super::parse_host_header("192.168.4.38:99999").is_none());
    }

    #[test]
    fn parse_host_header_trims_whitespace() {
        let (host, port) = super::parse_host_header("  10.0.0.1:8080  ").unwrap();
        assert_eq!(host, "10.0.0.1");
        assert_eq!(port, 8080);
    }

    // ─── PILOT-242: IPv6 connect-target formatting ───

    #[test]
    fn join_host_port_brackets_ipv6_literals() {
        // Hostnames and IPv4 pass through unchanged.
        assert_eq!(
            join_host_port("firestore.googleapis.com", 443),
            "firestore.googleapis.com:443"
        );
        assert_eq!(join_host_port("142.250.151.95", 443), "142.250.151.95:443");
        // Bare IPv6 literals get bracketed so TcpStream::connect can parse them.
        assert_eq!(
            join_host_port("2a00:1450:4009:c08::8a", 443),
            "[2a00:1450:4009:c08::8a]:443"
        );
        assert_eq!(join_host_port("::1", 8080), "[::1]:8080");
        // Already-bracketed literals are left alone.
        assert_eq!(
            join_host_port("[2a00:1450::8a]", 443),
            "[2a00:1450::8a]:443"
        );
        // The result parses as a SocketAddr for IPv6.
        assert!(join_host_port("2a00:1450:4009:c08::8a", 443)
            .parse::<std::net::SocketAddr>()
            .is_ok());
    }

    // ─── PILOT-245: HTTP/2 MITM vs passthrough decision ───

    #[test]
    fn requires_tls_passthrough_decision() {
        let alpn = |protos: &[&[u8]]| protos.iter().map(|p| p.to_vec()).collect::<Vec<_>>();
        // No ALPN at all → plain HTTPS client → MITM.
        assert!(!requires_tls_passthrough(&alpn(&[])));
        // HTTP/1.x offered → MITM.
        assert!(!requires_tls_passthrough(&alpn(&[b"http/1.1"])));
        assert!(!requires_tls_passthrough(&alpn(&[b"http/1.0"])));
        assert!(!requires_tls_passthrough(&alpn(&[b"h2", b"http/1.1"])));
        // h2-only (gRPC-Core/BoringSSL) → MITM now that the engine speaks h2.
        assert!(!requires_tls_passthrough(&alpn(&[b"h2"])));
        // A list containing h2 alongside an exotic protocol → MITM.
        assert!(!requires_tls_passthrough(&alpn(&[b"grpc-exp", b"h2"])));
        // Exotic ALPN-only with no protocol we speak → passthrough.
        assert!(requires_tls_passthrough(&alpn(&[b"grpc-exp"])));
    }

    #[test]
    fn host_glob_matches_semantics() {
        // Exact match, case-insensitive.
        assert!(host_glob_matches("api.example.com", "api.example.com"));
        assert!(host_glob_matches("API.Example.COM", "api.example.com"));
        assert!(!host_glob_matches("api.example.com", "cdn.example.com"));
        // `*.` prefix matches subdomains AND the bare domain.
        assert!(host_glob_matches("*.example.com", "api.example.com"));
        assert!(host_glob_matches("*.example.com", "a.b.example.com"));
        assert!(host_glob_matches("*.example.com", "example.com"));
        assert!(!host_glob_matches("*.example.com", "example.org"));
        assert!(!host_glob_matches("*.example.com", "notexample.com"));
        // `**.` accepted as an alias.
        assert!(host_glob_matches("**.example.com", "api.example.com"));
        // Mid-pattern `*`.
        assert!(host_glob_matches("example.*", "example.co.uk"));
        assert!(host_glob_matches("192.168.1.*", "192.168.1.7"));
        // Dots are literal, not regex wildcards.
        assert!(!host_glob_matches("192.168.1.7", "192x168x1x7"));
    }

    /// Drain a rustls ClientConnection's pending handshake bytes.
    fn drain_client_hello(alpn: &[&[u8]], sni: &str) -> Vec<u8> {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut config = ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        let server_name = rustls::pki_types::ServerName::try_from(sni.to_string()).unwrap();
        let mut conn = rustls::ClientConnection::new(Arc::new(config), server_name).unwrap();
        let mut hello = Vec::new();
        conn.write_tls(&mut hello).unwrap();
        hello
    }

    #[tokio::test]
    async fn read_client_hello_records_exact_bytes() {
        use tokio::io::AsyncWriteExt;

        let hello = drain_client_hello(&[b"h2"], "example.test");
        assert!(!hello.is_empty());

        let (mut client_side, mut server_side) = tokio::io::duplex(65536);
        // Write the hello in two split chunks to exercise the partial-read
        // loop in read_client_hello.
        let split = hello.len() / 2;
        let (first, second) = hello.split_at(split);
        let first = first.to_vec();
        let second = second.to_vec();
        let writer = tokio::spawn(async move {
            client_side.write_all(&first).await.unwrap();
            tokio::task::yield_now().await;
            client_side.write_all(&second).await.unwrap();
            client_side
        });

        let info = read_client_hello(&mut server_side).await.unwrap();
        writer.await.unwrap();
        assert_eq!(info.sni.as_deref(), Some("example.test"));
        assert_eq!(info.alpn, vec![b"h2".to_vec()]);
        assert_eq!(info.recorded, hello);
    }

    #[tokio::test]
    async fn read_client_hello_rejects_non_tls_bytes() {
        use tokio::io::AsyncWriteExt;
        let (mut client_side, mut server_side) = tokio::io::duplex(8192);
        client_side
            .write_all(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
            .await
            .unwrap();
        assert!(read_client_hello(&mut server_side).await.is_err());
    }

    /// Self-signed origin TLS server config + the cert clients must trust.
    fn origin_server_config(
        hostname: &str,
        alpn: &[&[u8]],
    ) -> (
        Arc<rustls::ServerConfig>,
        rustls::pki_types::CertificateDer<'static>,
    ) {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec![hostname.to_string()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let cert_der = cert.der().clone();
        let key_der: rustls::pki_types::PrivateKeyDer<'static> =
            rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into();
        let mut config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der.clone()], key_der)
            .unwrap();
        config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        (Arc::new(config), cert_der)
    }

    /// Client config that trusts ONLY the given cert (not the MITM CA), so a
    /// successful handshake proves the connection was NOT intercepted.
    fn client_config_trusting(
        cert: &rustls::pki_types::CertificateDer<'static>,
        alpn: &[&[u8]],
    ) -> Arc<ClientConfig> {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.add(cert.clone()).unwrap();
        let mut config = ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        Arc::new(config)
    }

    fn empty_proxy_state(passthrough_hosts: Vec<String>) -> Arc<Mutex<ProxyState>> {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let client_config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config: client_config.clone(),
            h2_client_config: client_config,
            handler: None,
            network_hosts: Vec::new(),
            passthrough_hosts: passthrough_hosts
                .iter()
                .map(|p| compile_host_glob(p).unwrap())
                .collect(),
        }))
    }

    /// Spawn a one-connection TLS origin server on an ephemeral loopback
    /// port. After the handshake it writes `banner` and shuts down.
    async fn spawn_tls_origin(
        server_config: Arc<rustls::ServerConfig>,
        banner: &'static [u8],
    ) -> u16 {
        use tokio::io::AsyncWriteExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
            let mut tls = acceptor.accept(tcp).await.unwrap();
            tls.write_all(banner).await.unwrap();
            tls.shutdown().await.ok();
        });
        port
    }

    async fn run_passthrough_client(
        client_config: Arc<ClientConfig>,
        client_side: tokio::io::DuplexStream,
        sni: &str,
    ) -> (Option<Vec<u8>>, Vec<u8>) {
        use tokio::io::AsyncReadExt;
        let server_name = rustls::pki_types::ServerName::try_from(sni.to_string()).unwrap();
        let mut tls = TlsConnector::from(client_config)
            .connect(server_name, client_side)
            .await
            .expect("client handshake should succeed end-to-end");
        let negotiated = tls.get_ref().1.alpn_protocol().map(|p| p.to_vec());
        let mut received = Vec::new();
        tls.read_to_end(&mut received).await.ok();
        (negotiated, received)
    }

    #[tokio::test]
    async fn exotic_alpn_client_is_tunneled_end_to_end() {
        // h2 is now MITM'd (PILOT-245), but a client offering only an ALPN we
        // can't speak (here `grpc-exp` with no h2/http1) is still tunneled.
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) = origin_server_config("passthrough.test", &[b"grpc-exp"]);
        let origin_port = spawn_tls_origin(server_config, b"hello-from-origin").await;

        let state = empty_proxy_state(Vec::new());
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "127.0.0.1".to_string(),
                origin_port,
                proxy_state,
                ca,
            )
            .await;
        });

        // The client trusts ONLY the origin's self-signed cert. If the proxy
        // had MITM'd this connection, the handshake would fail.
        let client_config = client_config_trusting(&origin_cert, &[b"grpc-exp"]);
        let (negotiated, received) =
            run_passthrough_client(client_config, client_side, "passthrough.test").await;
        assert_eq!(negotiated.as_deref(), Some(b"grpc-exp".as_slice()));
        assert_eq!(received, b"hello-from-origin");

        proxy_task.await.unwrap();
        let entries = state.lock().await.entries.clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].route_action, "passthrough");
        assert_eq!(entries[0].method, "CONNECT");
        // The entry records the SNI hostname (what the app asked for), not
        // the redirector-resolved IP.
        assert_eq!(
            entries[0].url,
            format!("https://passthrough.test:{origin_port}/")
        );
        assert!(entries[0].is_https);
    }

    #[tokio::test]
    async fn configured_passthrough_host_is_tunneled_even_for_http1_client() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) =
            origin_server_config("pinned.example.com", &[b"http/1.1"]);
        let origin_port = spawn_tls_origin(server_config, b"pinned-origin").await;

        // SNI-glob passthrough rule; the client offers plain http/1.1 ALPN,
        // which would normally be MITM'd.
        let state = empty_proxy_state(vec!["*.example.com".to_string()]);
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "127.0.0.1".to_string(),
                origin_port,
                proxy_state,
                ca,
            )
            .await;
        });

        let client_config = client_config_trusting(&origin_cert, &[b"http/1.1"]);
        let (negotiated, received) =
            run_passthrough_client(client_config, client_side, "pinned.example.com").await;
        assert_eq!(negotiated.as_deref(), Some(b"http/1.1".as_slice()));
        assert_eq!(received, b"pinned-origin");

        proxy_task.await.unwrap();
        let entries = state.lock().await.entries.clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].route_action, "passthrough");
    }

    #[tokio::test]
    async fn http1_client_is_mitmd() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        // Client trusts the MITM CA and offers only http/1.1. The proxy MITMs
        // it on the HTTP/1.1 pipeline. (Dual-protocol clients also negotiate
        // http/1.1 by server preference; only h2-only clients take the h2 path.)
        let client_config = client_config_trusting_ca(&ca, &[b"http/1.1"]);

        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config: client_config.clone(),
            h2_client_config: client_config.clone(),
            handler: Some(Arc::new(SyntheticHttpsHandler { seen_tx })),
            network_hosts: Vec::new(),
            passthrough_hosts: Vec::new(),
        }));

        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_task = tokio::spawn(async move {
            // 192.0.2.1 (TEST-NET) is never dialed: the route handler
            // synthesizes the response before any upstream connect.
            handle_transparent_tls(server_side, "192.0.2.1".to_string(), 443, proxy_state, ca)
                .await;
        });

        let server_name =
            rustls::pki_types::ServerName::try_from("example.test".to_string()).unwrap();
        let mut client_tls = TlsConnector::from(client_config)
            .connect(server_name, client_side)
            .await
            .expect("http/1.1 client must complete the MITM handshake");
        assert_eq!(
            client_tls.get_ref().1.alpn_protocol(),
            Some(b"http/1.1".as_slice()),
            "proxy must negotiate http/1.1 with an http/1.1-only client"
        );

        client_tls
            .write_all(b"GET /users/1 HTTP/1.1\r\nHost: example.test\r\n\r\n")
            .await
            .unwrap();
        let seen = tokio::time::timeout(std::time::Duration::from_secs(2), seen_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(seen, "https://example.test/users/1");

        let mut response = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(2), client_tls.read(&mut buf))
                .await
                .unwrap()
            {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);
                    if response.windows(11).any(|w| w == br#"{"ok":true}"#) {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => panic!("client read failed: {e}"),
            }
        }
        drop(client_tls);
        proxy_task.await.unwrap();

        let entries = state.lock().await.entries.clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].route_action, "mocked");
    }

    #[tokio::test]
    async fn connect_path_tunnels_exotic_alpn_client() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) = origin_server_config("grpc.test", &[b"grpc-exp"]);
        let origin_port = spawn_tls_origin(server_config, b"grpc-origin").await;

        let proxy = NetworkProxy::start(ca).await.unwrap();
        let mut tcp = TcpStream::connect(("127.0.0.1", proxy.port()))
            .await
            .unwrap();
        tcp.write_all(format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut ack = vec![0u8; 64];
        let n = tcp.read(&mut ack).await.unwrap();
        assert!(String::from_utf8_lossy(&ack[..n]).starts_with("HTTP/1.1 200"));

        let client_config = client_config_trusting(&origin_cert, &[b"grpc-exp"]);
        let server_name = rustls::pki_types::ServerName::try_from("grpc.test".to_string()).unwrap();
        let mut tls = TlsConnector::from(client_config)
            .connect(server_name, tcp)
            .await
            .expect("exotic-ALPN CONNECT client must be tunneled, not MITM'd");
        assert_eq!(
            tls.get_ref().1.alpn_protocol(),
            Some(b"grpc-exp".as_slice())
        );
        let mut received = Vec::new();
        tls.read_to_end(&mut received).await.ok();
        assert_eq!(received, b"grpc-origin");

        let entries = proxy.stop().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].route_action, "passthrough");
        assert_eq!(entries[0].url, format!("https://grpc.test:{origin_port}/"));
    }

    // ─── PILOT-245: HTTP/2 MITM interception ───

    /// A fixed 64 KiB frame used to push streaming responses past the default
    /// HTTP/2 initial window so the flow-control path is exercised.
    static BIG_FRAME: [u8; 65536] = [0x5a; 65536];

    /// Spawn a one-connection HTTP/2 origin. For each accepted stream it drains
    /// the request body, then replies `200` with `count` DATA frames each equal
    /// to `frame`, optionally followed by a trailer.
    async fn spawn_h2_origin(
        server_config: Arc<rustls::ServerConfig>,
        frame: &'static [u8],
        count: usize,
        trailer: Option<(&'static str, &'static str)>,
    ) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
            let tls = acceptor.accept(tcp).await.unwrap();
            let mut conn = h2::server::handshake(tls).await.unwrap();
            while let Some(Ok((req, mut respond))) = conn.accept().await {
                let mut body = req.into_body();
                while let Some(Ok(chunk)) = body.data().await {
                    let _ = body.flow_control().release_capacity(chunk.len());
                }
                let _ = body.trailers().await;

                let response = http::Response::builder()
                    .status(200)
                    .header("content-type", "application/grpc")
                    .body(())
                    .unwrap();
                let mut send = respond.send_response(response, false).unwrap();
                // Rely on h2's internal buffering/flush (driven by the accept
                // loop) — fine for a test origin and avoids the full-window
                // wait that would deadlock for frames >= the initial window.
                for _ in 0..count {
                    send.send_data(bytes::Bytes::from_static(frame), false)
                        .unwrap();
                }
                match trailer {
                    Some((k, v)) => {
                        let mut tr = http::HeaderMap::new();
                        tr.insert(
                            http::HeaderName::from_static(k),
                            http::HeaderValue::from_static(v),
                        );
                        send.send_trailers(tr).unwrap();
                    }
                    None => send.send_data(bytes::Bytes::new(), true).unwrap(),
                }
            }
        });
        port
    }

    /// Drive one h2 request over `io` and return the response status, the full
    /// concatenated body, and any trailers.
    async fn run_h2_client(
        client_config: Arc<ClientConfig>,
        io: tokio::io::DuplexStream,
        sni: &str,
        authority: &str,
        path: &str,
    ) -> (http::StatusCode, Vec<u8>, Option<http::HeaderMap>) {
        let server_name = rustls::pki_types::ServerName::try_from(sni.to_string()).unwrap();
        let tls = TlsConnector::from(client_config)
            .connect(server_name, io)
            .await
            .expect("h2 client handshake must succeed against the MITM cert");
        assert_eq!(tls.get_ref().1.alpn_protocol(), Some(b"h2".as_slice()));

        let (send_req, conn) = h2::client::handshake(tls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let mut send_req = send_req.ready().await.unwrap();
        let req = http::Request::builder()
            .method("POST")
            .uri(format!("https://{authority}{path}"))
            .header("content-type", "application/grpc")
            .body(())
            .unwrap();
        let (resp_fut, mut body_send) = send_req.send_request(req, false).unwrap();
        body_send
            .send_data(bytes::Bytes::from_static(b"ping"), true)
            .unwrap();

        let response = resp_fut.await.unwrap();
        let status = response.status();
        let mut body = response.into_body();
        let mut received = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.unwrap();
            received.extend_from_slice(&chunk);
            body.flow_control().release_capacity(chunk.len()).unwrap();
        }
        let trailers = body.trailers().await.unwrap();
        (status, received, trailers)
    }

    /// Poll until at least `n` entries are captured (the h2 path records on a
    /// spawned per-stream task, so the capture can lag the client slightly).
    async fn wait_for_entries(state: &Arc<Mutex<ProxyState>>, n: usize) -> Vec<CapturedEntry> {
        for _ in 0..100 {
            let entries = state.lock().await.entries.clone();
            if entries.len() >= n {
                return entries;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {n} captured entries");
    }

    /// Build a ProxyState whose upstream configs trust the given origin cert
    /// (so the proxy can complete its upstream TLS handshake in tests).
    fn proxy_state_trusting(
        origin_cert: &rustls::pki_types::CertificateDer<'static>,
        handler: Option<Arc<dyn NetworkHandler>>,
    ) -> Arc<Mutex<ProxyState>> {
        let upstream_cfg = client_config_trusting(origin_cert, &[b"h2", b"http/1.1"]);
        Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config: upstream_cfg.clone(),
            h2_client_config: upstream_cfg,
            handler,
            network_hosts: Vec::new(),
            passthrough_hosts: Vec::new(),
        }))
    }

    /// Build a client config that trusts the MITM CA, offering the given ALPN.
    fn client_config_trusting_ca(ca: &MitmAuthority, alpn: &[&[u8]]) -> Arc<ClientConfig> {
        let mut root_store = rustls::RootCertStore::empty();
        let ca_pem = std::fs::read(ca.ca_pem_path()).unwrap();
        let mut reader = std::io::BufReader::new(ca_pem.as_slice());
        for cert in rustls_pemfile::certs(&mut reader) {
            root_store.add(cert.unwrap()).unwrap();
        }
        let mut config = ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        Arc::new(config)
    }

    #[tokio::test]
    async fn h2_only_client_is_mitmd() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) = origin_server_config("grpc.test", &[b"h2"]);
        let origin_port =
            spawn_h2_origin(server_config, b"pong", 1, Some(("grpc-status", "0"))).await;

        let state = proxy_state_trusting(&origin_cert, None);
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_ca = ca.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "127.0.0.1".to_string(),
                origin_port,
                proxy_state,
                proxy_ca,
            )
            .await;
        });

        // The client trusts the MITM CA and offers only h2 (like gRPC-Core).
        let client_config = client_config_trusting_ca(&ca, &[b"h2"]);
        let (status, body, trailers) = run_h2_client(
            client_config,
            client_side,
            "grpc.test",
            "grpc.test",
            "/svc.Service/Method",
        )
        .await;

        assert_eq!(status, http::StatusCode::OK);
        assert_eq!(body, b"pong");
        let trailers = trailers.expect("grpc trailers must be forwarded through the MITM");
        assert_eq!(
            trailers.get("grpc-status").map(|v| v.as_bytes()),
            Some(b"0".as_slice())
        );

        let entries = wait_for_entries(&state, 1).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].route_action, "");
        assert_eq!(entries[0].method, "POST");
        assert_eq!(entries[0].url, "https://grpc.test/svc.Service/Method");
        assert_eq!(entries[0].status_code, 200);
        assert_eq!(entries[0].request_body, b"ping");
        assert_eq!(entries[0].request_size, 4);
        assert_eq!(entries[0].response_body, b"pong");
        assert!(entries[0].is_https);

        drop(proxy_task);
    }

    #[tokio::test]
    async fn h2_streaming_response_does_not_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) = origin_server_config("stream.test", &[b"h2"]);
        // 4 × 64 KiB = 256 KiB, well past the default 64 KiB window: completing
        // at all proves flow-control capacity is being released both ways.
        let origin_port = spawn_h2_origin(server_config, &BIG_FRAME, 4, None).await;

        let state = proxy_state_trusting(&origin_cert, None);
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_ca = ca.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "127.0.0.1".to_string(),
                origin_port,
                proxy_state,
                proxy_ca,
            )
            .await;
        });

        let client_config = client_config_trusting_ca(&ca, &[b"h2"]);
        // Generous timeout: it only exists to catch a flow-control deadlock
        // (which would hang forever); the exchange itself completes in ms.
        let (status, body, _trailers) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            run_h2_client(
                client_config,
                client_side,
                "stream.test",
                "stream.test",
                "/Listen",
            ),
        )
        .await
        .expect("streaming exchange must not deadlock");

        assert_eq!(status, http::StatusCode::OK);
        assert_eq!(body.len(), 4 * 65536);

        let entries = wait_for_entries(&state, 1).await;
        assert_eq!(entries[0].response_size, 4 * 65536);
        // The trace body is capped even though the full stream flowed through.
        assert!(entries[0].response_body.len() <= MAX_BODY_SIZE);

        drop(proxy_task);
    }

    /// ProxyState with a handler and webpki-root upstream config (no real
    /// origin needed for mock/abort tests).
    fn proxy_state_with_handler(handler: Arc<dyn NetworkHandler>) -> Arc<Mutex<ProxyState>> {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let cfg = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
            tls_client_config: cfg.clone(),
            h2_client_config: cfg,
            handler: Some(handler),
            network_hosts: Vec::new(),
            passthrough_hosts: Vec::new(),
        }))
    }

    #[tokio::test]
    async fn h2_route_mock_synthesizes_without_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (seen_tx, _seen_rx) = tokio::sync::mpsc::unbounded_channel();
        let state = proxy_state_with_handler(Arc::new(SyntheticHttpsHandler { seen_tx }));
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_ca = ca.clone();
        // Upstream is TEST-NET 192.0.2.1:443 — never dialed because the route
        // synthesizes the response.
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "192.0.2.1".to_string(),
                443,
                proxy_state,
                proxy_ca,
            )
            .await;
        });

        let client_config = client_config_trusting_ca(&ca, &[b"h2"]);
        let (status, body, _trailers) = run_h2_client(
            client_config,
            client_side,
            "example.test",
            "example.test",
            "/users/1",
        )
        .await;

        assert_eq!(status, http::StatusCode::OK);
        assert_eq!(body, br#"{"ok":true}"#);

        let entries = wait_for_entries(&state, 1).await;
        assert_eq!(entries[0].route_action, "mocked");
        assert_eq!(entries[0].url, "https://example.test/users/1");

        drop(proxy_task);
    }

    #[tokio::test]
    async fn h2_route_abort_resets_stream() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let state = proxy_state_with_handler(Arc::new(AbortHandler));
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_ca = ca.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "192.0.2.1".to_string(),
                443,
                proxy_state,
                proxy_ca,
            )
            .await;
        });

        let client_config = client_config_trusting_ca(&ca, &[b"h2"]);
        let server_name =
            rustls::pki_types::ServerName::try_from("example.test".to_string()).unwrap();
        let tls = TlsConnector::from(client_config)
            .connect(server_name, client_side)
            .await
            .unwrap();
        let (send_req, conn) = h2::client::handshake(tls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let mut send_req = send_req.ready().await.unwrap();
        let req = http::Request::builder()
            .method("POST")
            .uri("https://example.test/x")
            .body(())
            .unwrap();
        let (resp_fut, mut body_send) = send_req.send_request(req, false).unwrap();
        body_send
            .send_data(bytes::Bytes::from_static(b"ping"), true)
            .unwrap();

        assert!(
            resp_fut.await.is_err(),
            "an aborted h2 stream must surface as an error to the client"
        );

        let entries = wait_for_entries(&state, 1).await;
        assert_eq!(entries[0].route_action, "aborted");

        drop(proxy_task);
    }

    /// Test handler that appends `x-mut: yes` and continues the request.
    struct ContinueHandler;

    #[async_trait::async_trait]
    impl NetworkHandler for ContinueHandler {
        async fn matches(&self, _url: &str) -> bool {
            true
        }
        async fn on_request(
            &self,
            req: &mut ParsedRequest,
            _hostname: &str,
            _is_https: bool,
        ) -> RequestOutcome {
            req.headers.push(("x-mut".to_string(), "yes".to_string()));
            RequestOutcome::Continued
        }
    }

    /// Spawn a one-connection h2 origin that echoes the value of `echo_header`
    /// from each request back as the response body.
    async fn spawn_h2_echo_origin(
        server_config: Arc<rustls::ServerConfig>,
        echo_header: &'static str,
    ) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
            let tls = acceptor.accept(tcp).await.unwrap();
            let mut conn = h2::server::handshake(tls).await.unwrap();
            while let Some(Ok((req, mut respond))) = conn.accept().await {
                let val = req
                    .headers()
                    .get(echo_header)
                    .map(|v| v.to_str().unwrap_or("").to_string())
                    .unwrap_or_else(|| "none".to_string());
                let mut body = req.into_body();
                while let Some(Ok(chunk)) = body.data().await {
                    let _ = body.flow_control().release_capacity(chunk.len());
                }
                let _ = body.trailers().await;
                let response = http::Response::builder().status(200).body(()).unwrap();
                let mut send = respond.send_response(response, false).unwrap();
                send.send_data(bytes::Bytes::from(val), true).unwrap();
            }
        });
        port
    }

    #[tokio::test]
    async fn h2_route_continue_forwards_mutated_request() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Arc::new(
            MitmAuthority::generate_new(&dir.path().join("ca.pem"), &dir.path().join("ca-key.pem"))
                .unwrap(),
        );

        let (server_config, origin_cert) = origin_server_config("api.test", &[b"h2"]);
        let origin_port = spawn_h2_echo_origin(server_config, "x-mut").await;

        let state = proxy_state_trusting(&origin_cert, Some(Arc::new(ContinueHandler)));
        let (client_side, server_side) = tokio::io::duplex(65536);
        let proxy_state = state.clone();
        let proxy_ca = ca.clone();
        let proxy_task = tokio::spawn(async move {
            handle_transparent_tls(
                server_side,
                "127.0.0.1".to_string(),
                origin_port,
                proxy_state,
                proxy_ca,
            )
            .await;
        });

        let client_config = client_config_trusting_ca(&ca, &[b"h2"]);
        let (status, body, _trailers) =
            run_h2_client(client_config, client_side, "api.test", "api.test", "/x").await;

        assert_eq!(status, http::StatusCode::OK);
        // The origin echoes the header the handler injected, proving the
        // mutated request was forwarded upstream.
        assert_eq!(body, b"yes");

        let entries = wait_for_entries(&state, 1).await;
        assert_eq!(entries[0].route_action, "continued");

        drop(proxy_task);
    }
}
