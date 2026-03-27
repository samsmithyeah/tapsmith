use anyhow::{bail, Result};
use tracing::{debug, info};

use crate::adb;
use crate::ios;
use crate::platform::Platform;

/// Connection state of a tracked device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// Device detected but not yet selected.
    Discovered,
    /// Device is the active target.
    Active,
    /// Device was previously active but has disconnected.
    Disconnected,
}

/// Information about a connected device (Android or iOS).
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub serial: String,
    pub model: String,
    pub is_emulator: bool,
    pub state: ConnectionState,
    pub platform: Platform,
}

/// Manages the set of known devices and tracks the active device.
#[derive(Debug)]
pub struct DeviceManager {
    devices: Vec<DeviceInfo>,
    active_serial: Option<String>,
}

impl DeviceManager {
    pub fn new() -> Self {
        Self {
            devices: Vec::new(),
            active_serial: None,
        }
    }

    /// Refresh the list of devices from ADB and iOS simulators/devices.
    pub async fn refresh(&mut self) -> Result<&[DeviceInfo]> {
        // Collect all current device serials from both platforms
        let mut current_serials: Vec<String> = Vec::new();

        // ─── Android devices via ADB ───
        if let Ok(adb_devices) = adb::list_devices().await {
            for adb_dev in &adb_devices {
                if !adb_dev.is_online() {
                    continue;
                }
                current_serials.push(adb_dev.serial.clone());

                if let Some(existing) = self.devices.iter_mut().find(|d| d.serial == adb_dev.serial)
                {
                    if existing.state == ConnectionState::Disconnected {
                        existing.state = if self.active_serial.as_deref() == Some(&adb_dev.serial) {
                            ConnectionState::Active
                        } else {
                            ConnectionState::Discovered
                        };
                        debug!(serial = %existing.serial, "Device reconnected");
                    }
                } else {
                    let model = adb::get_device_model(&adb_dev.serial)
                        .await
                        .unwrap_or_else(|_| "unknown".to_string());

                    self.devices.push(DeviceInfo {
                        serial: adb_dev.serial.clone(),
                        model,
                        is_emulator: adb_dev.is_emulator(),
                        state: ConnectionState::Discovered,
                        platform: Platform::Android,
                    });
                    debug!(serial = %adb_dev.serial, "New Android device discovered");
                }
            }
        }

        // ─── iOS devices via xcrun simctl / devicectl ───
        if let Ok(ios_devices) = ios::device::list_all_devices().await {
            for ios_dev in &ios_devices {
                if ios_dev.is_simulator && !ios_dev.is_booted() {
                    continue; // Only show booted simulators
                }
                current_serials.push(ios_dev.udid.clone());

                if let Some(existing) = self.devices.iter_mut().find(|d| d.serial == ios_dev.udid) {
                    if existing.state == ConnectionState::Disconnected {
                        existing.state = if self.active_serial.as_deref() == Some(&ios_dev.udid) {
                            ConnectionState::Active
                        } else {
                            ConnectionState::Discovered
                        };
                        debug!(serial = %existing.serial, "iOS device reconnected");
                    }
                } else {
                    self.devices.push(DeviceInfo {
                        serial: ios_dev.udid.clone(),
                        model: ios_dev.name.clone(),
                        is_emulator: ios_dev.is_simulator,
                        state: ConnectionState::Discovered,
                        platform: Platform::Ios,
                    });
                    debug!(serial = %ios_dev.udid, name = %ios_dev.name, "New iOS device discovered");
                }
            }
        }

        // Mark devices no longer present as disconnected
        for device in &mut self.devices {
            if !current_serials.contains(&device.serial) {
                if device.state == ConnectionState::Active {
                    info!(serial = %device.serial, "Active device disconnected");
                }
                device.state = ConnectionState::Disconnected;
            }
        }

        // Remove long-gone disconnected devices that aren't active
        self.devices.retain(|d| {
            d.state != ConnectionState::Disconnected
                || self.active_serial.as_deref() == Some(&d.serial)
        });

        Ok(&self.devices)
    }

    /// Set the active device by serial.
    pub fn set_active(&mut self, serial: &str) -> Result<()> {
        let device = self.devices.iter_mut().find(|d| d.serial == serial);

        match device {
            Some(_) => {
                // Deactivate the current device
                if let Some(ref prev) = self.active_serial {
                    if let Some(prev_dev) = self.devices.iter_mut().find(|d| &d.serial == prev) {
                        prev_dev.state = ConnectionState::Discovered;
                    }
                }

                self.active_serial = Some(serial.to_string());
                if let Some(dev) = self.devices.iter_mut().find(|d| d.serial == serial) {
                    dev.state = ConnectionState::Active;
                }
                info!(serial, "Device set as active");
                Ok(())
            }
            None => {
                bail!(
                    "Device {serial} not found. Run ListDevices first to refresh the device list."
                );
            }
        }
    }

    /// Get the serial of the active device, if any.
    pub fn active_serial(&self) -> Option<&str> {
        self.active_serial.as_deref()
    }

    /// Get the active device info.
    #[allow(dead_code)]
    pub fn active_device(&self) -> Option<&DeviceInfo> {
        self.active_serial
            .as_ref()
            .and_then(|s| self.devices.iter().find(|d| &d.serial == s))
    }

    /// Get all known devices.
    pub fn devices(&self) -> &[DeviceInfo] {
        &self.devices
    }

    /// Add a device directly (for testing purposes).
    #[cfg(test)]
    pub(crate) fn add_device(&mut self, info: DeviceInfo) {
        self.devices.push(info);
    }

    /// Resolve the device serial to use for an operation.
    /// Returns the active device serial, or if there's exactly one device, auto-selects it.
    pub async fn resolve_serial(&mut self) -> Result<String> {
        if let Some(serial) = &self.active_serial {
            return Ok(serial.clone());
        }

        self.refresh().await?;

        let online: Vec<_> = self
            .devices
            .iter()
            .filter(|d| d.state != ConnectionState::Disconnected)
            .collect();

        match online.len() {
            0 => bail!("No devices connected. Connect a device or start an emulator."),
            1 => {
                let serial = online[0].serial.clone();
                self.set_active(&serial)?;
                info!(serial = %serial, "Auto-selected the only connected device");
                Ok(serial)
            }
            n => {
                bail!("{n} devices connected but none selected. Use SetDevice to choose one.");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_device(serial: &str, state: ConnectionState) -> DeviceInfo {
        DeviceInfo {
            serial: serial.to_string(),
            model: "TestModel".to_string(),
            is_emulator: serial.starts_with("emulator-"),
            state,
            platform: Platform::Android,
        }
    }

    #[test]
    fn new_manager_has_no_devices() {
        let dm = DeviceManager::new();
        assert!(dm.devices().is_empty());
        assert!(dm.active_serial().is_none());
        assert!(dm.active_device().is_none());
    }

    #[test]
    fn set_active_unknown_device_returns_error() {
        let mut dm = DeviceManager::new();
        let result = dm.set_active("nonexistent-serial");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("not found"),
            "Error should mention 'not found': {msg}"
        );
    }

    #[test]
    fn set_active_known_device_succeeds() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("ABC123", ConnectionState::Discovered));
        dm.add_device(make_device("DEF456", ConnectionState::Discovered));

        let result = dm.set_active("DEF456");
        assert!(result.is_ok());
        assert_eq!(dm.active_serial(), Some("DEF456"));

        let active = dm.active_device().unwrap();
        assert_eq!(active.serial, "DEF456");
        assert_eq!(active.state, ConnectionState::Active);
    }

    #[test]
    fn set_active_deactivates_previous() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("dev-1", ConnectionState::Discovered));
        dm.add_device(make_device("dev-2", ConnectionState::Discovered));

        dm.set_active("dev-1").unwrap();
        assert_eq!(dm.active_serial(), Some("dev-1"));

        dm.set_active("dev-2").unwrap();
        assert_eq!(dm.active_serial(), Some("dev-2"));

        // dev-1 should be back to Discovered
        let dev1 = dm.devices().iter().find(|d| d.serial == "dev-1").unwrap();
        assert_eq!(dev1.state, ConnectionState::Discovered);

        let dev2 = dm.devices().iter().find(|d| d.serial == "dev-2").unwrap();
        assert_eq!(dev2.state, ConnectionState::Active);
    }

    #[test]
    fn devices_returns_correct_list() {
        let mut dm = DeviceManager::new();
        assert_eq!(dm.devices().len(), 0);

        dm.add_device(make_device("emulator-5554", ConnectionState::Discovered));
        dm.add_device(make_device("HVA123", ConnectionState::Discovered));
        assert_eq!(dm.devices().len(), 2);

        let serials: Vec<&str> = dm.devices().iter().map(|d| d.serial.as_str()).collect();
        assert!(serials.contains(&"emulator-5554"));
        assert!(serials.contains(&"HVA123"));
    }

    #[test]
    fn connection_state_equality() {
        assert_eq!(ConnectionState::Discovered, ConnectionState::Discovered);
        assert_eq!(ConnectionState::Active, ConnectionState::Active);
        assert_eq!(ConnectionState::Disconnected, ConnectionState::Disconnected);
        assert_ne!(ConnectionState::Discovered, ConnectionState::Active);
        assert_ne!(ConnectionState::Active, ConnectionState::Disconnected);
    }

    #[test]
    fn active_device_returns_none_when_no_active() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("dev-1", ConnectionState::Discovered));
        assert!(dm.active_device().is_none());
    }
}
