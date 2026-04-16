//! Network route interception handler.
//!
//! Implements the [`NetworkHandler`] trait from `network_proxy` so that
//! matching HTTP(S) requests are paused, forwarded to the TypeScript SDK
//! over a gRPC bidirectional stream, and resolved according to the SDK's
//! routing decision (abort / continue / fulfill / fetch).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, RwLock};
use tracing::{debug, warn};

use crate::network_proxy::{NetworkHandler, ParsedRequest, ParsedResponse};
use crate::proto;

/// Timeout waiting for the SDK to send a [`RouteDecision`] before we
/// fail-open and forward the request upstream unchanged.
const HANDLER_TIMEOUT: Duration = Duration::from_secs(30);

/// A compiled route registration.
struct RegisteredRoute {
    route_id: String,
    /// Regex compiled from the user's glob pattern.
    pattern: regex::Regex,
}

/// The decision the SDK returned for a single intercepted request.
pub(crate) enum ResolvedDecision {
    Abort,
    Continue {
        url: Option<String>,
        method: Option<String>,
        headers: Option<Vec<(String, String)>>,
        post_data: Option<Vec<u8>>,
    },
    Fulfill(ParsedResponse),
    /// The SDK wants to fetch the real upstream response first. The caller
    /// should perform the upstream call and then call
    /// [`RouteInterceptHandler::complete_fetch`] with the result.
    #[allow(dead_code)]
    Fetch {
        url: Option<String>,
        method: Option<String>,
        headers: Option<Vec<(String, String)>>,
        post_data: Option<Vec<u8>>,
    },
}

/// Handler that bridges the MITM proxy to the SDK's route handlers via a
/// gRPC bidirectional stream.
pub(crate) struct RouteInterceptHandler {
    /// Registered routes, ordered by registration time. Last registered is
    /// checked first (Playwright priority: last `route()` call wins).
    routes: Arc<RwLock<Vec<RegisteredRoute>>>,
    /// Channel to send server messages (intercepted requests, fetched
    /// responses) to the gRPC stream writer task.
    to_sdk: mpsc::Sender<proto::NetworkRouteServerMessage>,
    /// Pending intercepts awaiting a SDK decision.
    pending: Arc<RwLock<HashMap<String, oneshot::Sender<proto::RouteDecision>>>>,
    /// Whether the SDK has subscribed to request/response events.
    events_subscribed: Arc<RwLock<bool>>,
}

impl RouteInterceptHandler {
    pub(crate) fn new(to_sdk: mpsc::Sender<proto::NetworkRouteServerMessage>) -> Self {
        Self {
            routes: Arc::new(RwLock::new(Vec::new())),
            to_sdk,
            pending: Arc::new(RwLock::new(HashMap::new())),
            events_subscribed: Arc::new(RwLock::new(false)),
        }
    }

    /// Register a new URL pattern route.
    pub(crate) async fn register_route(
        &self,
        route_id: String,
        url_pattern: &str,
    ) -> Result<(), String> {
        let regex = glob_to_regex(url_pattern)
            .map_err(|e| format!("Invalid URL pattern '{url_pattern}': {e}"))?;
        let mut routes = self.routes.write().await;
        routes.push(RegisteredRoute {
            route_id,
            pattern: regex,
        });
        Ok(())
    }

    /// Remove a registered route.
    pub(crate) async fn unregister_route(&self, route_id: &str) -> bool {
        let mut routes = self.routes.write().await;
        let before = routes.len();
        routes.retain(|r| r.route_id != route_id);
        routes.len() < before
    }

    /// Deliver a routing decision from the SDK for a pending intercept.
    pub(crate) async fn resolve_decision(&self, decision: proto::RouteDecision) {
        let intercept_id = decision.intercept_id.clone();
        let sender = self.pending.write().await.remove(&intercept_id);
        if let Some(tx) = sender {
            let _ = tx.send(decision);
        } else {
            warn!(
                %intercept_id,
                "RouteDecision for unknown intercept_id (timed out or duplicate)"
            );
        }
    }

    /// After a `RouteFetch` decision: send the real upstream response to the
    /// SDK so it can inspect/modify it, then await the final fulfill decision.
    pub(crate) async fn complete_fetch(
        &self,
        intercept_id: &str,
        response: &ParsedResponse,
    ) -> Option<proto::RouteFulfill> {
        // Send the fetched response to the SDK
        let msg = proto::NetworkRouteServerMessage {
            msg: Some(proto::network_route_server_message::Msg::FetchedResponse(
                proto::FetchedResponse {
                    intercept_id: intercept_id.to_string(),
                    status: response.status_code,
                    headers: response
                        .headers
                        .iter()
                        .map(|(n, v)| proto::HeaderEntry {
                            name: n.clone(),
                            value: v.clone(),
                        })
                        .collect(),
                    body: response.body.clone(),
                },
            )),
        };
        if self.to_sdk.send(msg).await.is_err() {
            warn!("Failed to send FetchedResponse — stream closed");
            return None;
        }

        // Re-register a pending slot for the same intercept_id (the SDK will
        // send a `fulfill_after_fetch` decision).
        let (tx, rx) = oneshot::channel();
        self.pending
            .write()
            .await
            .insert(intercept_id.to_string(), tx);

        match tokio::time::timeout(HANDLER_TIMEOUT, rx).await {
            Ok(Ok(decision)) => {
                if let Some(proto::route_decision::Action::FulfillAfterFetch(fulfill)) =
                    decision.action
                {
                    Some(fulfill)
                } else {
                    warn!("Expected fulfill_after_fetch, got different action");
                    None
                }
            }
            Ok(Err(_)) => {
                warn!("Fetch decision channel dropped");
                None
            }
            Err(_) => {
                warn!("Timeout waiting for fulfill_after_fetch decision");
                self.pending.write().await.remove(intercept_id);
                None
            }
        }
    }

    /// Enable event notifications.
    pub(crate) async fn subscribe_events(&self) {
        *self.events_subscribed.write().await = true;
    }

    /// Disable event notifications.
    pub(crate) async fn unsubscribe_events(&self) {
        *self.events_subscribed.write().await = false;
    }

    /// Send a request event notification (non-blocking, best-effort).
    #[allow(dead_code)]
    pub(crate) async fn notify_request(
        &self,
        req: &ParsedRequest,
        url: &str,
        is_https: bool,
        route_action: &str,
    ) {
        if !*self.events_subscribed.read().await {
            return;
        }
        let msg = proto::NetworkRouteServerMessage {
            msg: Some(proto::network_route_server_message::Msg::RequestEvent(
                proto::NetworkRequestEvent {
                    method: req.method.clone(),
                    url: url.to_string(),
                    headers: req
                        .headers
                        .iter()
                        .map(|(n, v)| proto::HeaderEntry {
                            name: n.clone(),
                            value: v.clone(),
                        })
                        .collect(),
                    body: req.body.clone(),
                    is_https,
                    route_action: route_action.to_string(),
                },
            )),
        };
        let _ = self.to_sdk.try_send(msg);
    }

    /// Send a response event notification (non-blocking, best-effort).
    #[allow(dead_code)]
    pub(crate) async fn notify_response(
        &self,
        req: &ParsedRequest,
        resp: &ParsedResponse,
        url: &str,
        route_action: &str,
    ) {
        if !*self.events_subscribed.read().await {
            return;
        }
        let msg = proto::NetworkRouteServerMessage {
            msg: Some(proto::network_route_server_message::Msg::ResponseEvent(
                proto::NetworkResponseEvent {
                    method: req.method.clone(),
                    url: url.to_string(),
                    status: resp.status_code,
                    headers: resp
                        .headers
                        .iter()
                        .map(|(n, v)| proto::HeaderEntry {
                            name: n.clone(),
                            value: v.clone(),
                        })
                        .collect(),
                    body: resp.body.clone(),
                    route_action: route_action.to_string(),
                },
            )),
        };
        let _ = self.to_sdk.try_send(msg);
    }

    /// Release all pending intercepts with fail-open (continue upstream).
    /// Called when the stream closes.
    pub(crate) async fn release_all_pending(&self) {
        let mut pending = self.pending.write().await;
        for (id, tx) in pending.drain() {
            debug!(%id, "Releasing pending intercept (stream closed)");
            let _ = tx.send(proto::RouteDecision {
                intercept_id: id,
                action: Some(proto::route_decision::Action::ContinueRequest(
                    proto::RouteContinue::default(),
                )),
            });
        }
    }

    /// Match a full URL against registered routes. Returns the route_id of
    /// the last-registered matching route (highest priority).
    async fn match_route(&self, url: &str) -> Option<String> {
        let routes = self.routes.read().await;
        // Iterate in reverse: last registered route has highest priority.
        for route in routes.iter().rev() {
            if route.pattern.is_match(url) {
                return Some(route.route_id.clone());
            }
        }
        None
    }

    /// Core interception logic: check if the URL matches a route, and if so
    /// send it to the SDK and await a decision. Returns the decision and the
    /// intercept_id (needed for multi-phase flows like `RouteFetch`).
    async fn intercept(
        &self,
        req: &ParsedRequest,
        hostname: &str,
        is_https: bool,
    ) -> Option<(ResolvedDecision, String)> {
        let scheme = if is_https { "https" } else { "http" };
        let url = format!("{scheme}://{hostname}{}", req.path);

        let route_id = self.match_route(&url).await?;

        let intercept_id = uuid::Uuid::new_v4().to_string();

        // Create the oneshot channel BEFORE sending the message so there's
        // no race between the SDK responding and us registering the receiver.
        let (tx, rx) = oneshot::channel();
        self.pending.write().await.insert(intercept_id.clone(), tx);

        let msg = proto::NetworkRouteServerMessage {
            msg: Some(
                proto::network_route_server_message::Msg::InterceptedRequest(
                    proto::InterceptedRequest {
                        intercept_id: intercept_id.clone(),
                        route_id,
                        method: req.method.clone(),
                        url: url.clone(),
                        headers: req
                            .headers
                            .iter()
                            .map(|(n, v)| proto::HeaderEntry {
                                name: n.clone(),
                                value: v.clone(),
                            })
                            .collect(),
                        body: req.body.clone(),
                        is_https,
                    },
                ),
            ),
        };

        if self.to_sdk.send(msg).await.is_err() {
            warn!("Failed to send InterceptedRequest — stream closed");
            self.pending.write().await.remove(&intercept_id);
            return None;
        }

        debug!(%intercept_id, %url, "Request intercepted, awaiting SDK decision");

        match tokio::time::timeout(HANDLER_TIMEOUT, rx).await {
            Ok(Ok(decision)) => {
                debug!(%intercept_id, "Received SDK routing decision");
                Some((decision_to_resolved(decision), intercept_id))
            }
            Ok(Err(_)) => {
                warn!(%intercept_id, "Decision channel dropped (stream closed?)");
                None // fail-open
            }
            Err(_) => {
                warn!(
                    %intercept_id, %url,
                    "Timeout ({HANDLER_TIMEOUT:?}) waiting for SDK routing decision — \
                     forwarding upstream (fail-open)"
                );
                self.pending.write().await.remove(&intercept_id);
                None // fail-open
            }
        }
    }
}

#[async_trait::async_trait]
impl NetworkHandler for RouteInterceptHandler {
    async fn on_request(
        &self,
        req: &mut ParsedRequest,
        hostname: &str,
        is_https: bool,
    ) -> Option<ParsedResponse> {
        let (decision, intercept_id) = self.intercept(req, hostname, is_https).await?;

        match decision {
            ResolvedDecision::Abort => {
                // Return a synthetic "connection reset" response. The proxy
                // will write this to the client then close the connection.
                Some(ParsedResponse {
                    status_code: 0,
                    headers: vec![("connection".to_string(), "close".to_string())],
                    body: Vec::new(),
                    raw_bytes: Vec::new(),
                })
            }
            ResolvedDecision::Continue {
                url,
                method,
                headers,
                post_data,
            } => {
                // Apply overrides to the mutable request.
                if let Some(m) = method {
                    if !m.is_empty() {
                        req.method = m;
                    }
                }
                if let Some(u) = url {
                    if !u.is_empty() {
                        // Extract path from full URL if it contains a scheme
                        if let Ok(parsed) = u.parse::<url::Url>() {
                            req.path = parsed.path().to_string();
                            if let Some(q) = parsed.query() {
                                req.path = format!("{}?{q}", req.path);
                            }
                        } else {
                            req.path = u;
                        }
                    }
                }
                if let Some(h) = headers {
                    if !h.is_empty() {
                        req.headers = h;
                    }
                }
                if let Some(b) = post_data {
                    if !b.is_empty() {
                        req.body = b;
                    }
                }
                None // proceed to upstream
            }
            ResolvedDecision::Fulfill(resp) => Some(resp),
            ResolvedDecision::Fetch {
                url: fetch_url,
                method: fetch_method,
                headers: fetch_headers,
                post_data: fetch_body,
            } => {
                // Make an independent upstream call, send the response to the
                // SDK for inspection/modification, and return the final response.
                let scheme = if is_https { "https" } else { "http" };
                let base_url = format!("{scheme}://{hostname}{}", req.path);
                let target_url = fetch_url.filter(|u| !u.is_empty()).unwrap_or(base_url);
                let target_method = fetch_method
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| req.method.clone());
                let target_headers = fetch_headers.unwrap_or_else(|| req.headers.clone());
                let target_body = fetch_body.unwrap_or_else(|| req.body.clone());

                match fetch_upstream(&target_url, &target_method, &target_headers, &target_body)
                    .await
                {
                    Some(upstream_resp) => {
                        // Use the original intercept_id so the SDK's
                        // fulfill_after_fetch decision routes correctly.
                        if let Some(fulfill) =
                            self.complete_fetch(&intercept_id, &upstream_resp).await
                        {
                            Some(fulfill_to_response(fulfill))
                        } else {
                            // Timeout or error — return the original upstream response
                            Some(upstream_resp)
                        }
                    }
                    None => {
                        warn!("RouteFetch: upstream request failed; forwarding original");
                        None
                    }
                }
            }
        }
    }

    async fn on_response(
        &self,
        _req: &ParsedRequest,
        _hostname: &str,
        _is_https: bool,
        _resp: &mut ParsedResponse,
    ) {
        // Response hooks are not used for route interception (Playwright
        // intercepts at the request stage). Event notifications happen at the
        // proxy level instead.
    }
}

// ─── Upstream Fetch (for RouteFetch) ───

/// Make a standalone HTTP/HTTPS request to the upstream server. Used by
/// `RouteFetch` to get the real response so the SDK can inspect/modify it.
async fn fetch_upstream(
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Option<ParsedResponse> {
    let parsed = url.parse::<url::Url>().ok()?;
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default()?;
    let is_tls = parsed.scheme() == "https";

    let connect_addr = format!("{host}:{port}");
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::net::TcpStream::connect(&connect_addr),
    )
    .await
    .ok()?
    .ok()?;

    // Build HTTP/1.1 request
    let path = if let Some(q) = parsed.query() {
        format!("{}?{q}", parsed.path())
    } else {
        parsed.path().to_string()
    };
    let mut req_buf = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (k, v) in headers {
        let lower = k.to_lowercase();
        // Skip headers we set ourselves or that would cause compressed responses
        if lower == "host"
            || lower == "connection"
            || lower == "proxy-connection"
            || lower == "accept-encoding"
        {
            continue;
        }
        req_buf.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body.is_empty() {
        req_buf.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req_buf.push_str("\r\n");

    if is_tls {
        fetch_upstream_tls(stream, host, &req_buf, body).await
    } else {
        fetch_upstream_plain(stream, &req_buf, body).await
    }
}

async fn fetch_upstream_plain(
    mut stream: tokio::net::TcpStream,
    request: &str,
    body: &[u8],
) -> Option<ParsedResponse> {
    use tokio::io::AsyncWriteExt;
    stream.write_all(request.as_bytes()).await.ok()?;
    if !body.is_empty() {
        stream.write_all(body).await.ok()?;
    }
    read_http_response(&mut stream).await
}

async fn fetch_upstream_tls(
    stream: tokio::net::TcpStream,
    host: &str,
    request: &str,
    body: &[u8],
) -> Option<ParsedResponse> {
    use tokio::io::AsyncWriteExt;

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let connector = tokio_rustls::TlsConnector::from(tls_config);
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string()).ok()?;
    let mut tls_stream = connector.connect(server_name, stream).await.ok()?;

    tls_stream.write_all(request.as_bytes()).await.ok()?;
    if !body.is_empty() {
        tls_stream.write_all(body).await.ok()?;
    }
    read_http_response(&mut tls_stream).await
}

async fn read_http_response<S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> Option<ParsedResponse> {
    use tokio::io::AsyncReadExt;

    let mut data = Vec::new();
    let mut buf = vec![0u8; 8192];
    let max_size = 10 * 1024 * 1024; // 10 MB
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(30), stream.read(&mut buf)).await
        {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                data.extend_from_slice(&buf[..n]);
                if data.len() > max_size {
                    break;
                }
            }
            Ok(Err(_)) | Err(_) => break,
        }
    }

    if data.is_empty() {
        return None;
    }

    let status_code = crate::network_proxy::parse_status_code(&data);
    let (headers, header_end) = crate::network_proxy::parse_headers(&data);
    let raw_body = if header_end < data.len() {
        data[header_end..].to_vec()
    } else {
        Vec::new()
    };

    // Decode chunked transfer encoding if present
    let is_chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    let body = if is_chunked {
        decode_chunked(&raw_body)
    } else {
        raw_body
    };

    // Strip transfer-encoding from headers since the body is now decoded
    let headers: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("transfer-encoding"))
        .collect();

    Some(ParsedResponse {
        status_code,
        headers,
        body,
        raw_bytes: data,
    })
}

/// Decode chunked transfer encoding into a plain body.
fn decode_chunked(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        // Find chunk size line (terminated by \r\n)
        let line_end = match data[pos..].windows(2).position(|w| w == b"\r\n") {
            Some(p) => pos + p,
            None => break,
        };
        let size_str = std::str::from_utf8(&data[pos..line_end]).unwrap_or("0");
        // Chunk extensions (after `;`) are ignored
        let size_hex = size_str.split(';').next().unwrap_or("0").trim();
        let chunk_size = usize::from_str_radix(size_hex, 16).unwrap_or(0);
        if chunk_size == 0 {
            break; // Final chunk
        }
        let chunk_start = line_end + 2;
        let chunk_end = chunk_start + chunk_size;
        if chunk_end > data.len() {
            break; // Incomplete chunk
        }
        result.extend_from_slice(&data[chunk_start..chunk_end]);
        pos = chunk_end + 2; // Skip trailing \r\n
    }
    result
}

// ─── URL Glob → Regex ───

/// Convert a Playwright-style URL glob pattern to a regex.
///
/// Rules (matching Playwright):
/// - `**` matches any characters including `/`
/// - `*` matches any characters except `/`
/// - `?` matches a single character except `/`
/// - `{a,b}` matches `a` or `b`
/// - All other characters are regex-escaped
fn glob_to_regex(pattern: &str) -> Result<regex::Regex, regex::Error> {
    let mut re = String::with_capacity(pattern.len() * 2);
    re.push('^');

    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**` — match everything (including `/`)
                    re.push_str(".*");
                    i += 2;
                    // Skip optional trailing `/` after `**/`
                    if i < chars.len() && chars[i] == '/' {
                        re.push_str("(?:/)?");
                        i += 1;
                    }
                } else {
                    // `*` — match everything except `/`
                    re.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                re.push_str("[^/]");
                i += 1;
            }
            '{' => {
                // Find matching `}`
                if let Some(close) = chars[i..].iter().position(|&c| c == '}') {
                    let group = &chars[i + 1..i + close];
                    let alternatives: Vec<String> = group
                        .split(|&c| c == ',')
                        .map(|alt| {
                            alt.iter()
                                .map(|&c| regex_escape_char(c))
                                .collect::<String>()
                        })
                        .collect();
                    re.push('(');
                    re.push_str(&alternatives.join("|"));
                    re.push(')');
                    i += close + 1;
                } else {
                    re.push_str(&regex_escape_char('{'));
                    i += 1;
                }
            }
            c => {
                re.push_str(&regex_escape_char(c));
                i += 1;
            }
        }
    }

    re.push('$');
    regex::Regex::new(&re)
}

fn regex_escape_char(c: char) -> String {
    regex::escape(&c.to_string())
}

/// Convert a [`proto::RouteDecision`] into our internal enum.
fn decision_to_resolved(d: proto::RouteDecision) -> ResolvedDecision {
    match d.action {
        Some(proto::route_decision::Action::Abort(_)) => ResolvedDecision::Abort,
        Some(proto::route_decision::Action::ContinueRequest(c)) => ResolvedDecision::Continue {
            url: if c.url.is_empty() { None } else { Some(c.url) },
            method: if c.method.is_empty() {
                None
            } else {
                Some(c.method)
            },
            headers: if c.headers.is_empty() {
                None
            } else {
                Some(c.headers.into_iter().map(|h| (h.name, h.value)).collect())
            },
            post_data: if c.post_data.is_empty() {
                None
            } else {
                Some(c.post_data)
            },
        },
        Some(proto::route_decision::Action::Fulfill(f)) => {
            ResolvedDecision::Fulfill(fulfill_to_response(f))
        }
        Some(proto::route_decision::Action::Fetch(f)) => ResolvedDecision::Fetch {
            url: if f.url.is_empty() { None } else { Some(f.url) },
            method: if f.method.is_empty() {
                None
            } else {
                Some(f.method)
            },
            headers: if f.headers.is_empty() {
                None
            } else {
                Some(f.headers.into_iter().map(|h| (h.name, h.value)).collect())
            },
            post_data: if f.post_data.is_empty() {
                None
            } else {
                Some(f.post_data)
            },
        },
        Some(proto::route_decision::Action::FulfillAfterFetch(f)) => {
            ResolvedDecision::Fulfill(fulfill_to_response(f))
        }
        None => {
            warn!("RouteDecision with no action — treating as continue");
            ResolvedDecision::Continue {
                url: None,
                method: None,
                headers: None,
                post_data: None,
            }
        }
    }
}

fn fulfill_to_response(f: proto::RouteFulfill) -> ParsedResponse {
    let status = if f.status == 0 { 200 } else { f.status };
    let mut headers: Vec<(String, String)> =
        f.headers.into_iter().map(|h| (h.name, h.value)).collect();

    // Ensure content-type is set if provided
    if !f.content_type.is_empty()
        && !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
    {
        headers.push(("content-type".to_string(), f.content_type));
    }

    // Ensure content-length is set
    if !headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("content-length"))
    {
        headers.push(("content-length".to_string(), f.body.len().to_string()));
    }

    ParsedResponse {
        status_code: status,
        headers,
        body: f.body,
        raw_bytes: Vec::new(), // caller will reencode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_exact_url() {
        let re = glob_to_regex("https://example.com/api/posts").unwrap();
        assert!(re.is_match("https://example.com/api/posts"));
        assert!(!re.is_match("https://example.com/api/posts/1"));
    }

    #[test]
    fn glob_single_star() {
        let re = glob_to_regex("https://example.com/api/*").unwrap();
        assert!(re.is_match("https://example.com/api/posts"));
        assert!(re.is_match("https://example.com/api/users"));
        assert!(!re.is_match("https://example.com/api/posts/1"));
    }

    #[test]
    fn glob_double_star() {
        let re = glob_to_regex("**/api/**").unwrap();
        assert!(re.is_match("https://example.com/api/posts"));
        assert!(re.is_match("https://example.com/api/posts/1"));
        assert!(re.is_match("http://localhost:3000/api/v2/users"));
        assert!(!re.is_match("https://example.com/other"));
    }

    #[test]
    fn glob_double_star_prefix() {
        let re = glob_to_regex("**/posts*").unwrap();
        assert!(re.is_match("https://jsonplaceholder.typicode.com/posts"));
        assert!(re.is_match("https://jsonplaceholder.typicode.com/posts?_limit=3"));
        assert!(!re.is_match("https://jsonplaceholder.typicode.com/users/1"));
    }

    #[test]
    fn glob_braces() {
        let re = glob_to_regex("https://example.com/{api,v2}/*").unwrap();
        assert!(re.is_match("https://example.com/api/posts"));
        assert!(re.is_match("https://example.com/v2/posts"));
        assert!(!re.is_match("https://example.com/other/posts"));
    }

    #[test]
    fn glob_question_mark() {
        let re = glob_to_regex("https://example.com/api/v?/posts").unwrap();
        assert!(re.is_match("https://example.com/api/v1/posts"));
        assert!(re.is_match("https://example.com/api/v2/posts"));
        assert!(!re.is_match("https://example.com/api/v12/posts"));
    }
}
