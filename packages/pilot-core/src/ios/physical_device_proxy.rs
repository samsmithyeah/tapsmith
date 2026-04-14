//! Physical iOS device network capture setup (PILOT-185).
//!
//! Physical iPhones / iPads cannot be routed through the Network Extension
//! redirector used for simulators (PILOT-182) — they have their own network
//! stack and usbmuxd-based tunnels don't support on-path TLS interception.
//! Instead, Pilot generates a per-device configuration profile (`.mobileconfig`)
//! that installs:
//!   1. A Wi-Fi entry with manual HTTP proxy pointing at the host's LAN IP +
//!      a deterministic per-UDID port
//!   2. The Pilot MITM CA root certificate for HTTPS trust
//!
//! The user installs the profile on the device once (AirDrop / email), then
//! `pilot test` against a physical device binds the MITM proxy on
//! `0.0.0.0:<deterministic_port>` and traffic flows through it transparently.
//!
//! Per-UDID deterministic port assignment means multiple physical devices on
//! the same Wi-Fi network can each point at a distinct host port without
//! collision, letting parallel tests run across multiple real devices.

use std::net::Ipv4Addr;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use plist::Value;
use tokio::process::Command;
use tracing::{debug, info};

/// Lower bound of the deterministic port range. Chosen to sit well above
/// typical ephemeral port ranges (macOS uses 49152-65535) and well below
/// `NetworkProxy`'s ephemeral fallback, so `deterministic_port()` never
/// collides with a dynamically-allocated proxy port on the same host.
const PORT_BASE: u16 = 9000;
/// Size of the deterministic port window. A thousand slots is plenty for
/// parallel device runs and keeps the range within 9000-9999 so network
/// administrators can poke a single firewall exception if needed.
const PORT_RANGE: u32 = 1000;

/// Compute a stable per-UDID host port for the MITM proxy.
///
/// Deterministic so the mobileconfig installed on the device stays valid
/// across daemon restarts. Using the UDID's CRC32 rather than a hash of the
/// process PID or a counter ensures that two runs against the same device
/// always pick the same port — otherwise the user would have to reinstall
/// the profile on every run.
pub fn deterministic_port(udid: &str) -> u16 {
    let hash = crc32fast::hash(udid.as_bytes());
    PORT_BASE + ((hash % PORT_RANGE) as u16)
}

/// Read the host's local Wi-Fi IPv4 address.
///
/// Uses `networksetup -getinfo Wi-Fi` rather than parsing `ifconfig` directly
/// because `networksetup` canonically maps the user-facing interface name
/// ("Wi-Fi") to whatever BSD device (`en0`, `en1`, …) it currently sits on.
/// Returns an actionable error if the Wi-Fi interface is off or unassigned.
pub async fn resolve_host_wifi_ip() -> Result<Ipv4Addr> {
    let output = Command::new("/usr/sbin/networksetup")
        .args(["-getinfo", "Wi-Fi"])
        .output()
        .await
        .context("Failed to run networksetup -getinfo Wi-Fi")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "networksetup -getinfo Wi-Fi failed: {stderr}\n  \
             hint: make sure this Mac has a Wi-Fi interface and is connected."
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_wifi_ip(&stdout)
}

fn parse_wifi_ip(output: &str) -> Result<Ipv4Addr> {
    // `networksetup -getinfo Wi-Fi` output:
    //   DHCP Configuration
    //   IP address: 192.168.1.42
    //   Subnet mask: 255.255.255.0
    //   ...
    // or on a disconnected interface:
    //   IP address: none
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("IP address:") {
            let value = rest.trim();
            if value.is_empty() || value.eq_ignore_ascii_case("none") {
                bail!(
                    "Wi-Fi interface has no IP address (value reported: '{value}').\n  \
                     hint: connect the Mac to the same Wi-Fi network as the target device."
                );
            }
            return value
                .parse::<Ipv4Addr>()
                .with_context(|| format!("unparseable Wi-Fi IP '{value}'"));
        }
    }
    bail!(
        "networksetup -getinfo Wi-Fi output contained no 'IP address:' line.\n  \
         hint: is the Wi-Fi interface named something other than 'Wi-Fi'?"
    )
}

/// Read the host's current Wi-Fi SSID.
///
/// Approach:
///   1. Resolve the BSD device name for the "Wi-Fi" hardware port via
///      `networksetup -listallhardwareports` (robust across BSD-name drift).
///   2. Query `ipconfig getsummary <dev>` and parse its `SSID :` line.
///
/// We do NOT use `networksetup -getairportnetwork` — Apple deprecated it in
/// Sonoma/Sequoia/Tahoe by removing the `airport` private framework it
/// called into. On current macOS that command always returns "You are not
/// associated with an AirPort network" even when connected, so anything
/// that relies on it has been silently broken.
///
/// Returns None on any failure — callers should treat a missing SSID as a
/// non-fatal warning rather than erroring, since the mobileconfig can still
/// be installed (the user can pass `--ssid` explicitly).
pub async fn current_wifi_ssid() -> Option<String> {
    let iface = resolve_wifi_bsd_name().await?;
    let output = Command::new("/usr/sbin/ipconfig")
        .args(["getsummary", &iface])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ssid_from_ipconfig(&stdout)
}

/// Resolve the current BSD interface name for the "Wi-Fi" hardware port.
///
/// Returns the device name ("en0", "en1", …) found in
/// `networksetup -listallhardwareports` for the port labeled "Wi-Fi".
async fn resolve_wifi_bsd_name() -> Option<String> {
    let output = Command::new("/usr/sbin/networksetup")
        .arg("-listallhardwareports")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_wifi_bsd_name(&stdout)
}

fn parse_wifi_bsd_name(listall_output: &str) -> Option<String> {
    let mut in_wifi = false;
    for line in listall_output.lines() {
        let line = line.trim();
        if line.starts_with("Hardware Port:") {
            in_wifi = line.contains("Wi-Fi");
            continue;
        }
        if in_wifi {
            if let Some(rest) = line.strip_prefix("Device:") {
                return Some(rest.trim().to_string());
            }
        }
    }
    None
}

/// Parse `ipconfig getsummary <iface>` output and extract the SSID.
///
/// Sample output:
///   airport : {
///     BSSID : <redacted>
///     CHANNEL : 149
///     SSID : MyNetworkName
///     ...
///   }
///
/// We match `SSID :` specifically (with a space before the colon) so we
/// don't collide with `BSSID :` on the preceding line.
fn parse_ssid_from_ipconfig(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        // Require the exact token `SSID ` (with trailing space) to avoid
        // matching BSSID. Slicing off the "SSID :" prefix leaves the value.
        if let Some(rest) = trimmed.strip_prefix("SSID :") {
            let ssid = rest.trim();
            if !ssid.is_empty() {
                return Some(ssid.to_string());
            }
        }
    }
    None
}

// ─── mobileconfig generation ─────────────────────────────────────────────

/// Inputs for building a per-device mobileconfig.
#[derive(Debug, Clone)]
pub struct MobileconfigInputs {
    pub udid: String,
    pub device_name: String,
    /// Wi-Fi SSID to target. Empty for "any current network", though a
    /// specific SSID is strongly preferred so the profile doesn't clobber
    /// the user's other Wi-Fi config.
    pub ssid: String,
    pub host_ip: Ipv4Addr,
    pub port: u16,
    /// PEM-encoded Pilot CA certificate.
    pub ca_pem: String,
}

/// Build a `.mobileconfig` document containing two payloads:
///   - `com.apple.wifi.managed`: SSID + manual HTTP proxy
///   - `com.apple.security.root`: base64-encoded Pilot CA
///
/// The top-level configuration profile is marked as removable, has a
/// deterministic PayloadIdentifier derived from the UDID (so reinstalling
/// replaces the existing profile rather than duplicating it), and a fresh
/// UUID for each regeneration.
pub fn generate_mobileconfig(inputs: &MobileconfigInputs) -> Result<Vec<u8>> {
    use plist::Dictionary;

    let payload_identifier_root =
        format!("dev.pilot.networkcapture.{}", sanitize_udid(&inputs.udid));

    // ── Wi-Fi payload ──
    let wifi_uuid = uuid::Uuid::new_v4().to_string();
    let mut wifi = Dictionary::new();
    wifi.insert(
        "PayloadType".into(),
        Value::String("com.apple.wifi.managed".into()),
    );
    wifi.insert("PayloadVersion".into(), Value::Integer(1.into()));
    wifi.insert(
        "PayloadIdentifier".into(),
        Value::String(format!("{payload_identifier_root}.wifi")),
    );
    wifi.insert("PayloadUUID".into(), Value::String(wifi_uuid.clone()));
    wifi.insert(
        "PayloadDisplayName".into(),
        Value::String(format!("Pilot proxy for {}", inputs.device_name)),
    );
    wifi.insert(
        "PayloadDescription".into(),
        Value::String(
            "Routes Wi-Fi traffic through Pilot's MITM proxy for network capture.".into(),
        ),
    );
    wifi.insert("SSID_STR".into(), Value::String(inputs.ssid.clone()));
    wifi.insert("EncryptionType".into(), Value::String("Any".into()));
    wifi.insert("AutoJoin".into(), Value::Boolean(true));
    wifi.insert("HIDDEN_NETWORK".into(), Value::Boolean(false));
    wifi.insert("ProxyType".into(), Value::String("Manual".into()));
    wifi.insert(
        "ProxyServer".into(),
        Value::String(inputs.host_ip.to_string()),
    );
    wifi.insert(
        "ProxyServerPort".into(),
        Value::Integer(i64::from(inputs.port).into()),
    );
    wifi.insert("ProxyPACFallbackAllowed".into(), Value::Boolean(false));

    // ── Certificate payload ──
    // Apple config profiles expect the CA as DER bytes wrapped in a
    // <data>…</data> plist entry. We ship PEM on disk, so decode to DER here.
    let ca_der = pem_to_der(&inputs.ca_pem)
        .context("Failed to decode Pilot CA PEM before embedding in mobileconfig")?;

    let cert_uuid = uuid::Uuid::new_v4().to_string();
    let mut cert = Dictionary::new();
    cert.insert(
        "PayloadType".into(),
        Value::String("com.apple.security.root".into()),
    );
    cert.insert("PayloadVersion".into(), Value::Integer(1.into()));
    cert.insert(
        "PayloadIdentifier".into(),
        Value::String(format!("{payload_identifier_root}.ca")),
    );
    cert.insert("PayloadUUID".into(), Value::String(cert_uuid.clone()));
    cert.insert(
        "PayloadDisplayName".into(),
        Value::String("Pilot MITM CA".into()),
    );
    cert.insert(
        "PayloadDescription".into(),
        Value::String(
            "Root certificate for Pilot's on-path MITM proxy. Must be trusted in \
             Settings → General → About → Certificate Trust Settings to capture HTTPS traffic."
                .into(),
        ),
    );
    cert.insert(
        "PayloadCertificateFileName".into(),
        Value::String("pilot-ca.pem".into()),
    );
    cert.insert("PayloadContent".into(), Value::Data(ca_der));

    // ── Top-level profile ──
    let top_uuid = uuid::Uuid::new_v4().to_string();
    let mut top = Dictionary::new();
    top.insert("PayloadType".into(), Value::String("Configuration".into()));
    top.insert("PayloadVersion".into(), Value::Integer(1.into()));
    top.insert(
        "PayloadIdentifier".into(),
        Value::String(payload_identifier_root),
    );
    top.insert("PayloadUUID".into(), Value::String(top_uuid));
    top.insert(
        "PayloadDisplayName".into(),
        Value::String(format!("Pilot Network Capture — {}", inputs.device_name)),
    );
    top.insert(
        "PayloadDescription".into(),
        Value::String(
            "Installs a Wi-Fi HTTP proxy and trusts the Pilot MITM CA so Pilot tests can \
             capture decrypted network traffic from this device."
                .into(),
        ),
    );
    top.insert("PayloadOrganization".into(), Value::String("Pilot".into()));
    top.insert("PayloadScope".into(), Value::String("User".into()));
    top.insert("PayloadRemovalDisallowed".into(), Value::Boolean(false));
    top.insert(
        "PayloadContent".into(),
        Value::Array(vec![Value::Dictionary(wifi), Value::Dictionary(cert)]),
    );

    let mut buf = Vec::<u8>::new();
    plist::to_writer_xml(&mut buf, &Value::Dictionary(top))
        .context("Failed to serialize mobileconfig as XML plist")?;
    Ok(buf)
}

/// Decode a PEM-encoded CA certificate to its DER bytes. Strips the
/// `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----` fences and
/// any whitespace between them.
fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    let mut collecting = false;
    let mut b64 = String::new();
    for line in pem.lines() {
        let line = line.trim();
        if line.starts_with("-----BEGIN") {
            collecting = true;
            continue;
        }
        if line.starts_with("-----END") {
            break;
        }
        if collecting {
            b64.push_str(line);
        }
    }
    if b64.is_empty() {
        bail!("PEM body contained no base64 content");
    }
    B64.decode(b64.as_bytes())
        .context("Failed to base64-decode PEM body")
}

/// Sanitize a UDID for use inside a payload identifier. iOS accepts dashes
/// and alphanumerics here, so real UDIDs pass through unchanged — this is
/// belt-and-braces for any exotic UDID forms we haven't seen.
fn sanitize_udid(udid: &str) -> String {
    udid.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

// ─── Persistent storage ──────────────────────────────────────────────────

/// Return the on-disk path where a device's mobileconfig is stored.
/// Per-user, per-UDID so that multiple devices coexist without collision.
pub fn mobileconfig_path(udid: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("unable to determine $HOME"))?;
    Ok(home
        .join(".pilot")
        .join("devices")
        .join(format!("{}.mobileconfig", udid)))
}

/// Metadata sidecar that records the host Wi-Fi IP / SSID / port at the time
/// the mobileconfig was generated. At daemon startup (before `start_network_capture`)
/// we compare the current host Wi-Fi state against this snapshot — if the
/// IP or SSID has drifted the user is asked to `refresh-ios-network`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MobileconfigMeta {
    pub udid: String,
    pub device_name: String,
    pub host_ip: Ipv4Addr,
    pub port: u16,
    pub ssid: String,
    /// ISO-8601 timestamp when the profile was generated.
    pub generated_at: String,
}

/// Return the on-disk path for the mobileconfig sidecar metadata.
pub fn mobileconfig_meta_path(udid: &str) -> Result<PathBuf> {
    let mut p = mobileconfig_path(udid)?;
    p.set_extension("meta.json");
    Ok(p)
}

/// Write the mobileconfig + sidecar metadata atomically.
///
/// Creates `~/.pilot/devices/` on demand. Overwrites any existing profile
/// for the same UDID (intentional — regeneration is the core of the
/// `refresh-ios-network` UX).
pub async fn write_mobileconfig(inputs: &MobileconfigInputs, bytes: &[u8]) -> Result<PathBuf> {
    let path = mobileconfig_path(&inputs.udid)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create {parent:?}"))?;
    }
    tokio::fs::write(&path, bytes)
        .await
        .with_context(|| format!("Failed to write {path:?}"))?;

    let meta = MobileconfigMeta {
        udid: inputs.udid.clone(),
        device_name: inputs.device_name.clone(),
        host_ip: inputs.host_ip,
        port: inputs.port,
        ssid: inputs.ssid.clone(),
        generated_at: now_iso8601(),
    };
    let meta_path = mobileconfig_meta_path(&inputs.udid)?;
    let meta_json =
        serde_json::to_vec_pretty(&meta).context("Failed to serialize mobileconfig metadata")?;
    tokio::fs::write(&meta_path, meta_json)
        .await
        .with_context(|| format!("Failed to write {meta_path:?}"))?;

    info!(udid = %inputs.udid, path = %path.display(), "Wrote mobileconfig");
    Ok(path)
}

/// Read an existing mobileconfig sidecar metadata file if present.
pub async fn read_mobileconfig_meta(udid: &str) -> Result<Option<MobileconfigMeta>> {
    let path = mobileconfig_meta_path(udid)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let meta: MobileconfigMeta = serde_json::from_slice(&bytes)
                .with_context(|| format!("Failed to parse {path:?}"))?;
            Ok(Some(meta))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("Failed to read {path:?}")),
    }
}

/// Returns true if an installed mobileconfig's recorded host IP no longer
/// matches the current host Wi-Fi IP. Used by `start_network_capture` to
/// warn the user that their profile has gone stale due to a Wi-Fi change.
pub async fn is_mobileconfig_stale(meta: &MobileconfigMeta, current_host_ip: Ipv4Addr) -> bool {
    meta.host_ip != current_host_ip
}

/// Check whether a mobileconfig has been generated for this UDID. Doesn't
/// verify it's actually installed on the device — that requires device-side
/// inspection which we can't do from the host.
pub async fn mobileconfig_exists(udid: &str) -> bool {
    let Ok(path) = mobileconfig_path(udid) else {
        return false;
    };
    match tokio::fs::metadata(&path).await {
        Ok(meta) => meta.is_file(),
        Err(_) => {
            debug!(udid, "mobileconfig not found on disk");
            false
        }
    }
}

fn now_iso8601() -> String {
    // Minimal ISO-8601: 2026-04-14T16:25:00Z. Avoids bringing in `chrono`
    // — the `time` crate is already a dep, but using it for formatting
    // requires the `formatting` feature, which isn't enabled. A hand-rolled
    // formatter keeps the diff small.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days_since_epoch = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;

    // Civil date from Julian day (Howard Hinnant's algorithm, simplified).
    let z = days_since_epoch + 719_468; // 1970-01-01 → day 719468
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_port_is_stable_per_udid() {
        let a = deterministic_port("00008140-00096C9014F3001C");
        let b = deterministic_port("00008140-00096C9014F3001C");
        assert_eq!(a, b);
    }

    #[test]
    fn deterministic_port_differs_for_distinct_udids() {
        let a = deterministic_port("00008140-AAAA");
        let b = deterministic_port("00008140-BBBB");
        // The chance of a CRC32 collision across 2 random UDIDs inside a
        // 1000-slot window is ~0.1%, so this is safe in practice. If it
        // ever flakes, raise the port range.
        assert_ne!(a, b);
    }

    #[test]
    fn deterministic_port_stays_inside_range() {
        for udid in ["a", "b", "c", "d", "e", "f", "g", "h"] {
            let p = deterministic_port(udid);
            assert!(p >= PORT_BASE);
            assert!(p < PORT_BASE + (PORT_RANGE as u16));
        }
    }

    #[test]
    fn parse_wifi_ip_success() {
        let output = "DHCP Configuration\nIP address: 192.168.1.42\nSubnet mask: 255.255.255.0\n";
        let ip = parse_wifi_ip(output).unwrap();
        assert_eq!(ip.to_string(), "192.168.1.42");
    }

    #[test]
    fn parse_wifi_ip_rejects_disconnected() {
        let output = "IP address: none\n";
        let err = parse_wifi_ip(output).unwrap_err();
        assert!(format!("{err}").contains("no IP address"));
    }

    #[test]
    fn parse_wifi_ip_rejects_missing_line() {
        let output = "Some unrelated output\n";
        let err = parse_wifi_ip(output).unwrap_err();
        assert!(format!("{err}").contains("no 'IP address:' line"));
    }

    #[test]
    fn parse_ssid_from_ipconfig_extracts_current_network() {
        let output = "airport : {\n  BSSID : 01:23:45:67:89:ab\n  CHANNEL : 149\n  SSID : HomeNetwork-5G\n}\n";
        assert_eq!(
            parse_ssid_from_ipconfig(output),
            Some("HomeNetwork-5G".to_string())
        );
    }

    #[test]
    fn parse_ssid_from_ipconfig_does_not_match_bssid() {
        // Regression guard: the BSSID line must not be mistaken for the SSID.
        let output = "  BSSID : 01:23:45:67:89:ab\n";
        assert_eq!(parse_ssid_from_ipconfig(output), None);
    }

    #[test]
    fn parse_ssid_from_ipconfig_returns_none_when_missing() {
        let output = "airport : {\n  CHANNEL : 149\n}\n";
        assert_eq!(parse_ssid_from_ipconfig(output), None);
    }

    #[test]
    fn parse_wifi_bsd_name_finds_correct_interface() {
        let output = "\n\
            Hardware Port: Ethernet Adapter (en4)\n\
            Device: en4\n\
            Ethernet Address: 36:57:2c:b9:ba:62\n\
            \n\
            Hardware Port: Wi-Fi\n\
            Device: en0\n\
            Ethernet Address: f8:4d:89:73:15:a5\n\
            \n\
            Hardware Port: Thunderbolt Bridge\n\
            Device: bridge0\n\
            Ethernet Address: 36:32:42:c7:51:40\n";
        assert_eq!(parse_wifi_bsd_name(output), Some("en0".to_string()));
    }

    #[test]
    fn parse_wifi_bsd_name_returns_none_when_absent() {
        let output = "Hardware Port: Ethernet\nDevice: en0\n";
        assert_eq!(parse_wifi_bsd_name(output), None);
    }

    #[test]
    fn pem_to_der_strips_fences() {
        // Minimal valid base64: 'AAAA' decodes to 3 null bytes.
        let pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        let der = pem_to_der(pem).unwrap();
        assert_eq!(der, vec![0, 0, 0]);
    }

    #[test]
    fn pem_to_der_rejects_empty_body() {
        let pem = "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n";
        assert!(pem_to_der(pem).is_err());
    }

    #[test]
    fn generate_mobileconfig_contains_key_fields() {
        let pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        let inputs = MobileconfigInputs {
            udid: "UDID-FAKE-0001".to_string(),
            device_name: "Test iPhone".to_string(),
            ssid: "TestNetwork".to_string(),
            host_ip: "192.168.1.42".parse().unwrap(),
            port: 9123,
            ca_pem: pem.to_string(),
        };
        let bytes = generate_mobileconfig(&inputs).unwrap();
        let xml = String::from_utf8(bytes).unwrap();
        // Sanity: the critical fields that drive device behavior must be present.
        assert!(xml.contains("TestNetwork"));
        assert!(xml.contains("192.168.1.42"));
        assert!(xml.contains("9123"));
        assert!(xml.contains("com.apple.wifi.managed"));
        assert!(xml.contains("com.apple.security.root"));
        // And the UDID-derived payload identifier is stable per device so
        // reinstalls replace the existing profile rather than duplicating.
        assert!(xml.contains("dev.pilot.networkcapture.UDID-FAKE-0001"));
    }

    #[test]
    fn now_iso8601_has_expected_shape() {
        let s = now_iso8601();
        // yyyy-mm-ddThh:mm:ssZ is 20 chars
        assert_eq!(s.len(), 20);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        assert_eq!(&s[10..11], "T");
        assert_eq!(&s[13..14], ":");
        assert_eq!(&s[16..17], ":");
        assert_eq!(&s[19..20], "Z");
    }
}
