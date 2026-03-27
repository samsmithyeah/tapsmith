use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::instrument;

/// Capture a PNG screenshot from an iOS simulator.
#[instrument]
pub async fn capture(udid: &str) -> Result<Vec<u8>> {
    let tmp_path = format!("/tmp/pilot_ios_screenshot_{}.png", uuid::Uuid::new_v4());

    let output = Command::new("xcrun")
        .args(["simctl", "io", udid, "screenshot", "--type=png", &tmp_path])
        .output()
        .await
        .context("Failed to run xcrun simctl io screenshot")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to capture screenshot from simulator {udid}: {stderr}");
    }

    let data = tokio::fs::read(&tmp_path)
        .await
        .context("Failed to read screenshot file")?;

    // Clean up temp file
    let _ = tokio::fs::remove_file(&tmp_path).await;

    // Validate PNG magic bytes
    if data.len() < 8 || &data[..4] != b"\x89PNG" {
        bail!(
            "Screenshot data is not a valid PNG (got {} bytes)",
            data.len()
        );
    }

    Ok(data)
}
