import { useState } from "react"
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as ExpoClipboard from "expo-clipboard"

export default function ClipboardScreen() {
  const [inputText, setInputText] = useState("Hello from Pilot!")
  const [pastedText, setPastedText] = useState("")
  const [copyCount, setCopyCount] = useState(0)

  const handleCopy = async () => {
    await ExpoClipboard.setStringAsync(inputText)
    setCopyCount((c) => c + 1)
  }

  const handlePaste = async () => {
    const text = await ExpoClipboard.getStringAsync()
    setPastedText(text)
  }

  const handleClear = () => {
    setInputText("")
    setPastedText("")
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Clipboard
      </Text>

      <Text style={styles.label}>Text to copy</Text>
      <TextInput
        style={styles.input}
        value={inputText}
        onChangeText={setInputText}
        placeholder="Enter text to copy"
        accessibilityLabel="Text to copy"
        testID="copy-input"
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.button}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel="Copy to clipboard"
          testID="copy-button"
        >
          <Text style={styles.buttonText}>Copy</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          onPress={handlePaste}
          accessibilityRole="button"
          accessibilityLabel="Paste from clipboard"
          testID="paste-button"
        >
          <Text style={styles.buttonText}>Paste</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={handleClear}
          accessibilityRole="button"
          accessibilityLabel="Clear"
          testID="clear-button"
        >
          <Text style={styles.buttonTextSecondary}>Clear</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Pasted content</Text>
      <View style={styles.pasteBox}>
        <Text style={styles.pastedText} testID="pasted-text">
          {pastedText || "(empty)"}
        </Text>
      </View>

      <Text style={styles.countText} testID="copy-count">
        Copied {copyCount} times
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
  pasteBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    minHeight: 60,
    marginBottom: 16,
  },
  pastedText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  countText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  spacer: {
    height: 32,
  },
})
