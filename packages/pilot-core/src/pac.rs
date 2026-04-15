//! Proxy Auto-Config (PAC) script generation for physical iOS network capture.
//!
//! When a device is set up with `ProxyType=Auto` + `ProxyAutoConfigDownloadURL`
//! in its Wi-Fi payload, iOS fetches a small JavaScript function from
//! `http://<host_ip>:<port>/pilot.pac` on every Wi-Fi join (and, iOS version
//! permitting, periodically thereafter). The function decides per-host whether
//! traffic should route through the Pilot proxy or go DIRECT.
//!
//! Why PAC instead of `ProxyType=Manual`:
//!
//!   1. **Automatic fallback when Pilot is down.** With `PROXY …; DIRECT` as
//!      the proxy list, iOS transparently falls back to DIRECT when the proxy
//!      socket is unreachable. Users can leave the profile installed
//!      permanently and the phone works with or without Pilot running —
//!      no more toggle-the-proxy dance between "testing" and "normal use".
//!   2. **Host filtering upstream of the MITM.** Apple OCSP/CRL, other apps'
//!      traffic, and iOS system services never reach our proxy at all,
//!      shrinking the OCSP-race surface and dropping the need for the
//!      `MITM_PASSTHROUGH_SUFFIXES` allowlist (which remains in place as a
//!      safety net until the PAC path has been verified on-device).
//!
//! Gotchas:
//!
//!   - iOS caches PAC responses aggressively, typically until the device
//!     leaves and rejoins the Wi-Fi network. Changes to `trace.networkHosts`
//!     in pilot.config.ts may not take effect until the user toggles Wi-Fi.
//!     `pilot verify-ios-network` fetches the live PAC from the daemon and
//!     compares it to the configured one, so stale caches are caught rather
//!     than silently producing wrong traces.
//!   - The proxy listener must be bound *before* iOS tries to fetch the PAC
//!     on Wi-Fi join. On a cold-boot scenario where the phone associates
//!     Wi-Fi before `pilot test` runs, the fetch fails and iOS falls back to
//!     DIRECT (correctly — we'd rather direct connections than silent
//!     drops). The next Wi-Fi reassociation picks up the proxy.

/// Build a PAC script that routes matching hosts through `<proxy_host>:<proxy_port>`
/// and everything else DIRECT.
///
/// `proxy_host` is typically lifted from the `Host:` header of the incoming
/// PAC fetch request — whatever address iOS used to reach the daemon is by
/// definition an address iOS can use for the proxy itself.
///
/// `network_hosts` is the user's `trace.networkHosts` glob list. An empty
/// list means "route everything through the proxy" — the same as the old
/// `ProxyType=Manual` behavior, so users who don't set an allowlist get
/// identical routing.
///
/// Glob semantics match what `trace.networkHosts` documents: a `*` in a
/// pattern matches any sequence of characters in the host. The PAC runtime's
/// built-in `shExpMatch(host, pattern)` honors this; we just inline each
/// pattern into a disjunction.
///
/// Security note: patterns are user-provided via pilot.config.ts. We escape
/// any character that could break out of the quoted JS string literal
/// (backslash, double-quote, newline, carriage return) before emitting.
/// Globs otherwise pass through verbatim to `shExpMatch`.
pub fn generate_pac_script(proxy_host: &str, proxy_port: u16, network_hosts: &[String]) -> String {
    let proxy_directive = format!("PROXY {proxy_host}:{proxy_port}; DIRECT");
    let proxy_directive_escaped = escape_js_string(&proxy_directive);

    if network_hosts.is_empty() {
        return format!(
            "// Pilot auto-generated PAC (catch-all — no trace.networkHosts configured)\n\
             function FindProxyForURL(url, host) {{\n\
             \x20\x20return \"{proxy_directive_escaped}\";\n\
             }}\n"
        );
    }

    let mut branches = String::new();
    for (idx, pattern) in network_hosts.iter().enumerate() {
        let escaped = escape_js_string(pattern);
        if idx == 0 {
            branches.push_str(&format!("  if (shExpMatch(h, \"{escaped}\")"));
        } else {
            branches.push_str(&format!(" || shExpMatch(h, \"{escaped}\")"));
        }
    }
    branches.push_str(") {\n");
    branches.push_str(&format!("    return \"{proxy_directive_escaped}\";\n"));
    branches.push_str("  }\n");

    format!(
        "// Pilot auto-generated PAC — filters to trace.networkHosts allowlist\n\
         function FindProxyForURL(url, host) {{\n\
         \x20\x20var h = host.toLowerCase();\n\
         {branches}\
         \x20\x20return \"DIRECT\";\n\
         }}\n"
    )
}

/// Escape a string for safe inclusion inside a JavaScript double-quoted
/// string literal. Replaces backslash, double-quote, CR, and LF. Everything
/// else passes through — glob metacharacters (`*`, `?`, `[]`) are valid
/// JavaScript string contents and are interpreted by `shExpMatch` at PAC
/// evaluation time.
fn escape_js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_host_list_emits_catch_all() {
        let pac = generate_pac_script("192.168.1.5", 9037, &[]);
        assert!(pac.contains("return \"PROXY 192.168.1.5:9037; DIRECT\""));
        assert!(!pac.contains("shExpMatch"));
        assert!(!pac.contains("DIRECT;"));
    }

    #[test]
    fn single_host_emits_one_branch() {
        let pac = generate_pac_script("10.0.0.2", 9000, &["api.example.com".to_string()]);
        assert!(pac.contains("shExpMatch(h, \"api.example.com\")"));
        assert!(pac.contains("return \"PROXY 10.0.0.2:9000; DIRECT\""));
        assert!(pac.contains("return \"DIRECT\""));
    }

    #[test]
    fn multiple_hosts_are_or_ed_together() {
        let pac = generate_pac_script(
            "10.0.0.2",
            9000,
            &["*.myapp.com".to_string(), "api.example.com".to_string()],
        );
        assert!(pac.contains("shExpMatch(h, \"*.myapp.com\")"));
        assert!(pac.contains(" || shExpMatch(h, \"api.example.com\")"));
    }

    #[test]
    fn host_lowercased_before_matching() {
        let pac = generate_pac_script("10.0.0.2", 9000, &["example.com".to_string()]);
        assert!(pac.contains("var h = host.toLowerCase()"));
    }

    #[test]
    fn escapes_double_quotes_and_backslashes_in_pattern() {
        // Not a valid glob but we should not break PAC generation either way.
        let pac = generate_pac_script(
            "10.0.0.2",
            9000,
            &["evil\"host".to_string(), "back\\slash".to_string()],
        );
        assert!(pac.contains("shExpMatch(h, \"evil\\\"host\")"));
        assert!(pac.contains("shExpMatch(h, \"back\\\\slash\")"));
    }

    #[test]
    fn generated_pac_starts_with_comment() {
        let pac = generate_pac_script("192.168.1.5", 9037, &[]);
        assert!(pac.starts_with("// Pilot"));
    }
}
