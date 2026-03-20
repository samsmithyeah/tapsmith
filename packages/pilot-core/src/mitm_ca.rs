//! MITM Certificate Authority for HTTPS interception.
//!
//! Generates a root CA on first use, persists it to `~/.pilot/`, and creates
//! per-host leaf certificates signed by that CA. Each host's `ServerConfig`
//! is cached so TLS handshakes are fast on repeat visits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose,
};
use rustls::ServerConfig;
use time::{Duration, OffsetDateTime};
use tokio::sync::Mutex;
use tracing::{debug, info};

/// Directory under the user's home where CA files are stored.
const PILOT_DIR: &str = ".pilot";
const CA_CERT_FILENAME: &str = "ca.pem";
const CA_KEY_FILENAME: &str = "ca-key.pem";

/// MITM certificate authority that generates per-host TLS certificates.
pub struct MitmAuthority {
    ca_cert: rcgen::Certificate,
    ca_key: KeyPair,
    ca_pem_path: PathBuf,
    host_cache: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl MitmAuthority {
    /// Load an existing CA from disk, or generate a new one.
    pub fn load_or_create() -> Result<Self> {
        let pilot_dir = Self::pilot_dir()?;
        std::fs::create_dir_all(&pilot_dir)
            .with_context(|| format!("Failed to create {}", pilot_dir.display()))?;

        let cert_path = pilot_dir.join(CA_CERT_FILENAME);
        let key_path = pilot_dir.join(CA_KEY_FILENAME);

        if cert_path.exists() && key_path.exists() {
            info!(path = %cert_path.display(), "Loading existing MITM CA");
            Self::load_from_disk(&cert_path, &key_path)
        } else {
            info!(path = %cert_path.display(), "Generating new MITM CA");
            Self::generate_new(&cert_path, &key_path)
        }
    }

    /// Path to the CA PEM certificate file (for pushing to device).
    pub fn ca_pem_path(&self) -> &Path {
        &self.ca_pem_path
    }

    /// Get or create a `rustls::ServerConfig` for the given hostname.
    /// Results are cached so subsequent calls for the same host are fast.
    pub async fn server_config_for_host(&self, hostname: &str) -> Result<Arc<ServerConfig>> {
        // Fast path: check cache
        let mut cache = self.host_cache.lock().await;
        if let Some(config) = cache.get(hostname) {
            return Ok(config.clone());
        }

        debug!(hostname, "Generating leaf certificate for MITM");

        let host_key = KeyPair::generate().context("Failed to generate host key pair")?;

        let mut params = CertificateParams::new(vec![hostname.to_string()])
            .context("Failed to create cert params for host")?;

        let now = OffsetDateTime::now_utc();
        params.not_before = now.checked_sub(Duration::days(1)).unwrap_or(now);
        params.not_after = now.checked_add(Duration::days(365)).unwrap_or(now);

        params.distinguished_name.push(DnType::CommonName, hostname);
        params.key_usages.push(KeyUsagePurpose::DigitalSignature);
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ServerAuth);

        let cert = params
            .signed_by(&host_key, &self.ca_cert, &self.ca_key)
            .context("Failed to sign host certificate")?;

        let cert_der = cert.der().clone();
        let key_der = rustls::pki_types::PrivatePkcs8KeyDer::from(host_key.serialize_der()).into();

        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der)
            .context("Failed to build rustls ServerConfig for host")?;

        let config = Arc::new(config);
        cache.insert(hostname.to_string(), config.clone());
        Ok(config)
    }

    // ─── Private helpers ───

    fn pilot_dir() -> Result<PathBuf> {
        let home = std::env::var("HOME").context("HOME environment variable not set")?;
        Ok(PathBuf::from(home).join(PILOT_DIR))
    }

    fn generate_new(cert_path: &Path, key_path: &Path) -> Result<Self> {
        let ca_key = KeyPair::generate().context("Failed to generate CA key pair")?;

        let mut params =
            CertificateParams::new(Vec::default()).context("Failed to create CA cert params")?;

        let now = OffsetDateTime::now_utc();
        params.not_before = now.checked_sub(Duration::days(1)).unwrap_or(now);
        params.not_after = now.checked_add(Duration::days(3650)).unwrap_or(now);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, "Pilot MITM CA");
        params
            .distinguished_name
            .push(DnType::OrganizationName, "Pilot");
        params.key_usages.push(KeyUsagePurpose::KeyCertSign);
        params.key_usages.push(KeyUsagePurpose::CrlSign);

        let ca_cert = params
            .self_signed(&ca_key)
            .context("Failed to self-sign CA certificate")?;

        // Persist to disk
        let cert_pem = ca_cert.pem();
        let key_pem = ca_key.serialize_pem();
        std::fs::write(cert_path, &cert_pem)
            .with_context(|| format!("Failed to write CA cert to {}", cert_path.display()))?;
        std::fs::write(key_path, &key_pem)
            .with_context(|| format!("Failed to write CA key to {}", key_path.display()))?;

        // Restrict key file permissions to owner-only (0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Failed to set permissions on {}", key_path.display()))?;
        }

        info!(path = %cert_path.display(), "MITM CA certificate saved");

        Ok(Self {
            ca_cert,
            ca_key,
            ca_pem_path: cert_path.to_path_buf(),
            host_cache: Mutex::new(HashMap::new()),
        })
    }

    fn load_from_disk(cert_path: &Path, key_path: &Path) -> Result<Self> {
        let cert_pem = std::fs::read_to_string(cert_path)
            .with_context(|| format!("Failed to read CA cert from {}", cert_path.display()))?;
        let key_pem = std::fs::read_to_string(key_path)
            .with_context(|| format!("Failed to read CA key from {}", key_path.display()))?;

        let ca_key = KeyPair::from_pem(&key_pem).context("Failed to parse CA key from PEM")?;

        // Parse the existing CA cert so we can use it as an issuer
        let ca_params = CertificateParams::from_ca_cert_pem(&cert_pem)
            .context("Failed to parse CA cert params from PEM")?;
        let ca_cert = ca_params
            .self_signed(&ca_key)
            .context("Failed to reconstruct CA certificate from stored PEM")?;

        Ok(Self {
            ca_cert,
            ca_key,
            ca_pem_path: cert_path.to_path_buf(),
            host_cache: Mutex::new(HashMap::new()),
        })
    }
}
