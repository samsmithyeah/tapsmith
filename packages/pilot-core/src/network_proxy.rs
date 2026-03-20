//! HTTP/HTTPS forward proxy for network traffic capture during tracing.
//!
//! Starts a local TCP proxy that intercepts HTTP and HTTPS requests from the
//! device (configured via `adb shell settings put global http_proxy`). For
//! HTTPS, performs MITM interception using per-host certificates signed by
//! the Pilot CA to decrypt and capture request/response content.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, info, warn};

use crate::mitm_ca::MitmAuthority;

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
    pub request_headers: HashMap<String, String>,
    pub response_headers: HashMap<String, String>,
    pub request_body: Vec<u8>,
    pub response_body: Vec<u8>,
    pub is_https: bool,
}

/// Shared state for the proxy server.
struct ProxyState {
    entries: Vec<CapturedEntry>,
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

        let state = Arc::new(Mutex::new(ProxyState {
            entries: Vec::new(),
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
        match client.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 65536 {
                    debug!("Proxy request headers too large");
                    return;
                }
            }
            Err(e) => {
                debug!("Read error from proxy client: {e}");
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
    let upstream_tcp = match TcpStream::connect(&connect_target).await {
        Ok(s) => s,
        Err(e) => {
            debug!("CONNECT failed to {connect_target}: {e}");
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;

            state.lock().await.entries.push(CapturedEntry {
                method: "CONNECT".to_string(),
                url: format!("https://{target}"),
                status_code: 502,
                content_type: String::new(),
                request_size: 0,
                response_size: 0,
                start_time_ms: now_ms(),
                duration_ms: 0,
                request_headers: HashMap::new(),
                response_headers: HashMap::new(),
                request_body: Vec::new(),
                response_body: Vec::new(),
                is_https: true,
            });
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

    // TLS handshake with upstream using system root certificates
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let tls_client_config = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );

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
            match client_stream.read(&mut tmp).await {
                Ok(0) => return, // client closed
                Ok(n) => {
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
                Err(e) => {
                    debug!("MITM read from client for {hostname}: {e}");
                    return;
                }
            }
        }

        let request_str = String::from_utf8_lossy(&request_buf);
        let first_line = request_str.lines().next().unwrap_or("");
        let parts: Vec<&str> = first_line.split_whitespace().collect();

        if parts.len() < 3 {
            debug!("Invalid MITM HTTP request line: {first_line}");
            return;
        }

        let method = parts[0].to_string();
        let path = parts[1].to_string();
        let url = format!("https://{hostname}{path}");

        let (req_headers, header_end) = parse_headers(&request_str);

        // Read request body if Content-Length is set
        let content_length: usize = req_headers
            .get("Content-Length")
            .or_else(|| req_headers.get("content-length"))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

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

        // Read response from upstream
        let mut response_buf = Vec::new();
        loop {
            match upstream_stream.read(&mut tmp).await {
                Ok(0) => break, // upstream closed
                Ok(n) => {
                    response_buf.extend_from_slice(&tmp[..n]);
                    if response_complete(&response_buf) {
                        break;
                    }
                    if response_buf.len() > 10 * 1024 * 1024 {
                        // 10MB safety limit
                        break;
                    }
                }
                Err(e) => {
                    debug!("MITM read from upstream for {hostname}: {e}");
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
        let response_str = String::from_utf8_lossy(&response_buf);
        let status_code = parse_status_code(&response_str);
        let (resp_headers, resp_header_end) = parse_headers(&response_str);
        let content_type = resp_headers
            .get("content-type")
            .or_else(|| resp_headers.get("Content-Type"))
            .cloned()
            .unwrap_or_default();
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
        let connection_close = resp_headers
            .get("Connection")
            .or_else(|| resp_headers.get("connection"))
            .map(|v| v.to_lowercase() == "close")
            .unwrap_or(false);

        let max_body = 1_048_576;
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
fn response_complete(buf: &[u8]) -> bool {
    let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(pos) => pos + 4,
        None => return false, // haven't received all headers yet
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end]);

    // Check for chunked transfer encoding
    let is_chunked = header_str.lines().any(|line| {
        let lower = line.to_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });

    if is_chunked {
        // The terminal chunk is "0\r\n\r\n" — only match at the buffer tail
        // to avoid false positives from body content.
        return buf.ends_with(b"0\r\n\r\n");
    }

    // Check Content-Length
    for line in header_str.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(len_str) = line.split_once(':').map(|(_, v)| v.trim()) {
                if let Ok(content_length) = len_str.parse::<usize>() {
                    return buf.len() >= header_end + content_length;
                }
            }
        }
    }

    // No Content-Length and not chunked — assume we need to read until close.
    // For keep-alive connections with no body indicators, the response is
    // just the headers (e.g., 204 No Content, 304 Not Modified).
    let status_line = header_str.lines().next().unwrap_or("");
    let status_code: i32 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

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
    let request_str = String::from_utf8_lossy(initial_data);
    let (req_headers, header_end) = parse_headers(&request_str);
    let request_body = if header_end < initial_data.len() {
        initial_data[header_end..].to_vec()
    } else {
        Vec::new()
    };

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

    let mut upstream = match TcpStream::connect(&connect_target).await {
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
                response_headers: HashMap::new(),
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

    // Read response until complete (Content-Length or chunked)
    let mut response_data = Vec::new();
    let mut buf = vec![0u8; 8192];
    loop {
        match upstream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                response_data.extend_from_slice(&buf[..n]);
                if response_complete(&response_data) {
                    break;
                }
                if response_data.len() > 10 * 1024 * 1024 {
                    break; // 10MB safety limit
                }
            }
            Err(_) => break,
        }
    }

    // Parse response status and headers
    let response_str = String::from_utf8_lossy(&response_data);
    let status_code = parse_status_code(&response_str);
    let (resp_headers, resp_header_end) = parse_headers(&response_str);
    let content_type = resp_headers
        .get("content-type")
        .or_else(|| resp_headers.get("Content-Type"))
        .cloned()
        .unwrap_or_default();
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
    let max_body = 1_048_576;
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
    let stripped = url.strip_prefix("http://")?;
    let (host, path) = match stripped.find('/') {
        Some(idx) => (stripped[..idx].to_string(), stripped[idx..].to_string()),
        None => (stripped.to_string(), "/".to_string()),
    };
    Some((host, path))
}

/// Parse headers from a raw HTTP message. Returns headers map and byte offset
/// of the body start.
fn parse_headers(raw: &str) -> (HashMap<String, String>, usize) {
    let mut headers = HashMap::new();
    let mut offset = 0;

    for (i, line) in raw.lines().enumerate() {
        offset += line.len() + 1; // rough estimate, corrected below by \r\n\r\n search
        if i == 0 {
            continue; // skip request/status line
        }
        if line.is_empty() || line == "\r" {
            break;
        }
        let clean = line.trim_end_matches('\r');
        if let Some((key, value)) = clean.split_once(':') {
            headers.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    // Find the actual \r\n\r\n boundary for body offset
    if let Some(pos) = raw.find("\r\n\r\n") {
        offset = pos + 4;
    } else if let Some(pos) = raw.find("\n\n") {
        offset = pos + 2;
    }

    (headers, offset)
}

/// Extract the status code from the first line of an HTTP response.
fn parse_status_code(response: &str) -> i32 {
    let first_line = response.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() >= 2 {
        parts[1].parse().unwrap_or(0)
    } else {
        0
    }
}
