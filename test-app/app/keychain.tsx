import { useState } from "react"
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as SecureStore from "expo-secure-store"

const STORAGE_KEY = "tapsmith-keychain-test"

export default function KeychainScreen() {
  const [inputText, setInputText] = useState("")
  const [storedValue, setStoredValue] = useState("")
  const [status, setStatus] = useState("")

  const handleSave = async () => {
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, inputText)
      setStatus("Saved")
    } catch (e) {
      setStatus(`Save failed: ${e}`)
    }
  }

  const handleLoad = async () => {
    try {
      const value = await SecureStore.getItemAsync(STORAGE_KEY)
      setStoredValue(value ?? "")
      setStatus("Loaded")
    } catch (e) {
      setStatus(`Load failed: ${e}`)
    }
  }

  const handleDelete = async () => {
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEY)
      setStoredValue("")
      setStatus("Deleted")
    } catch (e) {
      setStatus(`Delete failed: ${e}`)
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Keychain
      </Text>

      <Text style={styles.label}>Value to store securely</Text>
      <TextInput
        style={styles.input}
        value={inputText}
        onChangeText={setInputText}
        placeholder="Enter secret value"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Secret value"
        testID="keychain-input"
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.button}
          onPress={handleSave}
          accessibilityRole="button"
          accessibilityLabel="Save to keychain"
          testID="keychain-save-button"
        >
          <Text style={styles.buttonText}>Save</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          onPress={handleLoad}
          accessibilityRole="button"
          accessibilityLabel="Load from keychain"
          testID="keychain-load-button"
        >
          <Text style={styles.buttonText}>Load</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={handleDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete from keychain"
          testID="keychain-delete-button"
        >
          <Text style={styles.buttonTextSecondary}>Delete</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Stored value</Text>
      <View style={styles.valueBox}>
        <Text style={styles.valueText} testID="keychain-value">
          {storedValue || "(empty)"}
        </Text>
      </View>

      <Text style={styles.statusText} testID="keychain-status">
        {status}
      </Text>

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
    marginBottom: 16,
    color: "#1a1a1a",
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 6,
    color: "#333",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flex: 1,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  buttonTextSecondary: {
    color: "#666",
    fontSize: 16,
    fontWeight: "600",
  },
  valueBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    minHeight: 60,
    marginBottom: 16,
  },
  valueText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  statusText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  spacer: {
    height: 32,
  },
})
