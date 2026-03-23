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

/// Shared state for the proxy server.
struct ProxyState {
    entries: Vec<CapturedEntry>,
    tls_client_config: Arc<ClientConfig>,
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

    // Both sides are now decrypted — proxy HTTP traffic and capture it
    handle_mitm_http(client_tls, upstream_tls, &hostname, state).await;
}

/// Proxy decrypted HTTP traffic between client and upstream TLS streams,
/// capturing each request/response pair. Handles HTTP/1.1 keep-alive by
/// looping until the connection closes.
async fn handle_mitm_http<C, U>(
    mut client_stream: C,
    mut upstream_stream: U,
    hostname: &str,
    state: Arc<Mutex<ProxyState>>,
) where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let start = now_ms();

        // Read HTTP request from client
        let mut request_buf = Vec::new();
        let mut tmp = vec![0u8; 8192];
        loop {
            match tokio::time::timeout(CLIENT_READ_TIMEOUT, client_stream.read(&mut tmp)).await {
                Ok(Ok(0)) => return, // client closed
                Ok(Ok(n)) => {
                    request_buf.extend_from_slice(&tmp[..n]);
                    // Check if we have a complete set of headers
                    if request_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                    if request_buf.len() > 65536 {
                        debug!("MITM request headers too large for {hostname}");
                        return;
                    }
                }
                Ok(Err(e)) => {
                    debug!("MITM read from client for {hostname}: {e}");
                    return;
                }
                Err(_) => {
                    debug!("MITM client header read timed out for {hostname}");
                    return;
                }
            }
        }

        let first_line_end = request_buf.iter().position(|&b| b == b'\n').unwrap_or(0);
        let first_line_str = String::from_utf8_lossy(&request_buf[..first_line_end]);
        let first_line = first_line_str.trim();
        let parts: Vec<&str> = first_line.split_whitespace().collect();

        if parts.len() < 3 {
            debug!("Invalid MITM HTTP request line: {first_line}");
            return;
        }

        let method = parts[0].to_string();
        let path = parts[1].to_string();
        let url = format!("https://{hostname}{path}");

        let (req_headers, header_end) = parse_headers(&request_buf);

        // Read request body if Content-Length is set (capped to prevent OOM)
        let content_length: usize = get_header(&req_headers, "content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
            .min(MAX_PROXY_BODY);

        let body_so_far = if header_end < request_buf.len() {
            request_buf[header_end..].len()
        } else {
            0
        };

        if content_length > body_so_far {
            let remaining = content_length - body_so_far;
            let mut body_buf = vec![0u8; remaining];
            if let Err(e) = client_stream.read_exact(&mut body_buf).await {
                debug!("MITM reading request body for {hostname}: {e}");
                return;
            }
            request_buf.extend_from_slice(&body_buf);
        }

        let request_body = if header_end < request_buf.len() {
            request_buf[header_end..].to_vec()
        } else {
            Vec::new()
        };

        // Forward the complete request to upstream
        if upstream_stream.write_all(&request_buf).await.is_err() {
            return;
        }

        // Read response from upstream (with per-read timeout)
        let mut response_buf = Vec::new();
        loop {
            match tokio::time::timeout(UPSTREAM_READ_TIMEOUT, upstream_stream.read(&mut tmp)).await
            {
                Ok(Ok(0)) => break, // upstream closed
                Ok(Ok(n)) => {
                    response_buf.extend_from_slice(&tmp[..n]);
                    if response_complete(&response_buf) {
                        break;
                    }
                    if response_buf.len() > MAX_PROXY_BODY {
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

        if response_buf.is_empty() {
            return;
        }

        // Forward response to client
        if client_stream.write_all(&response_buf).await.is_err() {
            return;
        }

        // Parse response for capture
        let status_code = parse_status_code(&response_buf);
        let (resp_headers, resp_header_end) = parse_headers(&response_buf);
        let content_type = get_header(&resp_headers, "content-type")
            .unwrap_or_default()
            .to_string();
        let response_body = if resp_header_end < response_buf.len() {
            response_buf[resp_header_end..].to_vec()
        } else {
            Vec::new()
        };

        let duration = now_ms() - start;
        debug!(
            method = method.as_str(),
            url = url.as_str(),
            status_code,
            duration_ms = duration,
            "HTTPS request captured (MITM)"
        );

        // Check if the connection should stay alive (HTTP/1.1 keep-alive)
        // Must extract before moving resp_headers into the entry.
        let connection_close = get_header(&resp_headers, "connection")
            .map(|v| v.eq_ignore_ascii_case("close"))
            .unwrap_or(false);

        let max_body = MAX_BODY_SIZE;
        state.lock().await.entries.push(CapturedEntry {
            method,
            url,
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
            is_https: true,
        });

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
