import { useState } from "react"
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import * as Location from "expo-location"
import * as Notifications from "expo-notifications"
import { Camera } from "expo-camera"

export default function PermissionsScreen() {
  const [cameraStatus, setCameraStatus] = useState("unknown")
  const [locationStatus, setLocationStatus] = useState("unknown")
  const [notificationsStatus, setNotificationsStatus] = useState("unknown")

  const requestCamera = async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync()
      setCameraStatus(status)
    } catch {
      setCameraStatus("error")
    }
  }

  const requestLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync()
      setLocationStatus(status)
    } catch {
      setLocationStatus("error")
    }
  }

  const requestNotifications = async () => {
    try {
      const { status } = await Notifications.requestPermissionsAsync()
      setNotificationsStatus(status)
    } catch {
      setNotificationsStatus("error")
    }
  }

  const checkNotifications = async () => {
    try {
      const { status } = await Notifications.getPermissionsAsync()
      setNotificationsStatus(status)
    } catch {
      setNotificationsStatus("error")
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Permissions
      </Text>

      <Text style={styles.description}>Test granting and revoking runtime permissions.</Text>

      <View
        style={styles.permissionCard}
        accessible
        accessibilityLabel={`Camera permission: ${cameraStatus}`}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionName}>Camera</Text>
          <Text
            style={[
              styles.permissionStatus,
              cameraStatus === "granted" && styles.statusGranted,
              cameraStatus === "denied" && styles.statusDenied,
            ]}
            testID="camera-status"
          >
            {cameraStatus}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.button}
          onPress={requestCamera}
          accessibilityRole="button"
          accessibilityLabel="Request camera permission"
          testID="request-camera"
        >
          <Text style={styles.buttonText}>Request</Text>
        </TouchableOpacity>
      </View>

      <View
        style={styles.permissionCard}
        accessible
        accessibilityLabel={`Location permission: ${locationStatus}`}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionName}>Location</Text>
          <Text
            style={[
              styles.permissionStatus,
              locationStatus === "granted" && styles.statusGranted,
              locationStatus === "denied" && styles.statusDenied,
            ]}
            testID="location-status"
          >
            {locationStatus}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.button}
          onPress={requestLocation}
          accessibilityRole="button"
          accessibilityLabel="Request location permission"
          testID="request-location"
        >
          <Text style={styles.buttonText}>Request</Text>
        </TouchableOpacity>
      </View>

      <View
        style={styles.permissionCard}
        accessible
        accessibilityLabel={`Notifications permission: ${notificationsStatus}`}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionName}>Notifications</Text>
          <Text
            style={[
              styles.permissionStatus,
              notificationsStatus === "granted" && styles.statusGranted,
              notificationsStatus === "denied" && styles.statusDenied,
            ]}
            testID="notifications-status"
          >
            {notificationsStatus}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={checkNotifications}
          accessibilityRole="button"
          accessibilityLabel="Check notifications permission"
          testID="check-notifications"
        >
          <Text style={styles.buttonText}>Check</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={requestNotifications}
          accessibilityRole="button"
          accessibilityLabel="Request notifications permission"
          testID="request-notifications"
        >
          <Text style={styles.buttonText}>Request</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.spacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
    color: "#1a1a1a",
  },
  description: {
    fontSize: 14,
    color: "#666",
    marginBottom: 16,
  },
  permissionCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  permissionInfo: {
    flex: 1,
  },
  permissionName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  permissionStatus: {
    fontSize: 14,
    color: "#999",
    marginTop: 4,
  },
  statusGranted: {
    color: "#34C759",
  },
  statusDenied: {
    color: "#FF3B30",
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  buttonSecondary: {
    backgroundColor: "#8E8E93",
    marginRight: 8,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  spacer: {
    height: 32,
  },
})
