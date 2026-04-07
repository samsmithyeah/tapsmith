import { useState } from "react"
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native"

interface DataItem {
  id: number
  title: string
  value: string
}

export default function SlowLoadScreen() {
  const [data, setData] = useState<DataItem[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState("")
  const [counter, setCounter] = useState(0)

  const fetchData = (delay: number, shouldFail = false) => {
    setLoading(true)
    setError("")
    setData([])
    setProgress(0)

    const steps = 5
    const stepDelay = delay / steps

    let step = 0
    const interval = setInterval(() => {
      step++
      setProgress(Math.round((step / steps) * 100))

      if (step >= steps) {
        clearInterval(interval)
        setLoading(false)

        if (shouldFail) {
          setError("Network request failed: timeout")
        } else {
          setData([
            { id: 1, title: "User Profile", value: "John Doe" },
            { id: 2, title: "Email", value: "john@example.com" },
            { id: 3, title: "Status", value: "Active" },
            { id: 4, title: "Plan", value: "Premium" },
            { id: 5, title: "Created", value: "2024-01-15" },
          ])
        }
      }
    }, stepDelay)
  }

  const incrementCounter = () => {
    setCounter(0)
    const interval = setInterval(() => {
      setCounter((c) => {
        if (c >= 10) {
          clearInterval(interval)
          return c
        }
        return c + 1
      })
    }, 500)
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Slow Loading
      </Text>

      <Text style={styles.description}>
        Simulates network delays for testing timeouts and polling assertions.
      </Text>

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Data Fetching
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => fetchData(2000)}
        accessibilityRole="button"
        accessibilityLabel="Load data (2 seconds)"
        testID="load-2s"
      >
        <Text style={styles.buttonText}>Load Data (2s)</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.button}
        onPress={() => fetchData(5000)}
        accessibilityRole="button"
        accessibilityLabel="Load data (5 seconds)"
        testID="load-5s"
      >
        <Text style={styles.buttonText}>Load Data (5s)</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.buttonDanger]}
        onPress={() => fetchData(3000, true)}
        accessibilityRole="button"
        accessibilityLabel="Load data (will fail)"
        testID="load-fail"
      >
        <Text style={styles.buttonText}>Load Data (Fail)</Text>
      </TouchableOpacity>

      {loading && (
        <View
          style={styles.loadingContainer}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
          testID="loading-state"
        >
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading... {progress}%</Text>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        </View>
      )}

      {error ? (
        <Text style={styles.errorText} accessibilityRole="alert" testID="fetch-error">
          {error}
        </Text>
      ) : null}

      {data.length > 0 && (
        <View testID="data-loaded">
          {data.map((item) => (
            <View key={item.id} style={styles.dataRow} testID={`data-row-${item.id}`}>
              <Text style={styles.dataTitle}>{item.title}</Text>
              <Text style={styles.dataValue}>{item.value}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Polling Counter
      </Text>

      <Text style={styles.description}>
        Counter increments from 0 to 10 over 5 seconds. Use expect.poll() to wait for a specific
        value.
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={incrementCounter}
        accessibilityRole="button"
        accessibilityLabel="Start counter"
        testID="start-counter"
      >
        <Text style={styles.buttonText}>Start Counter</Text>
      </TouchableOpacity>

      <Text style={styles.counterText} testID="counter-value">
        {counter}
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
    marginBottom: 8,
    color: "#1a1a1a",
  },
  description: {
    fontSize: 14,
    color: "#666",
    marginBottom: 16,
    lineHeight: 20,
  },
  sectionHeader: {
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 24,
    marginBottom: 8,
    color: "#1a1a1a",
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginBottom: 8,
  },
  buttonDanger: {
    backgroundColor: "#FF3B30",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingContainer: {
    alignItems: "center",
    padding: 24,
  },
  loadingText: {
    fontSize: 16,
    color: "#007AFF",
    marginTop: 12,
  },
  progressBar: {
    height: 8,
    backgroundColor: "#f0f0f0",
    borderRadius: 4,
    marginTop: 12,
    width: "100%",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#007AFF",
    borderRadius: 4,
  },
  errorText: {
    backgroundColor: "#FFF0F0",
    color: "#FF3B30",
    fontSize: 14,
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  dataRow: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 14,
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  dataTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  dataValue: {
    fontSize: 16,
    color: "#666",
  },
  counterText: {
    fontSize: 64,
    fontWeight: "bold",
    color: "#007AFF",
    textAlign: "center",
    marginTop: 16,
  },
  spacer: {
    height: 32,
  },
})
