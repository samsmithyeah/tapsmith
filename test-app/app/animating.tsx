import { useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native"

/**
 * "Never-idle" screen — a regression repro for idle-gated element queries.
 *
 * Mirrors a real app's story-generation screen ("Creating your story") that
 * never lets the UI go idle: a continuously looping animation plus an
 * indeterminate progress spinner that never completes. The accessibility-event
 * stream therefore never quiets, so any wait machinery gated on global idle
 * (UiAutomator's waitForIdle / Until.hasObject) would block for its full
 * timeout even though the stable elements below are fully visible.
 *
 * The animation uses the core RN Animated API with `useNativeDriver: false` so
 * it is JS-driven and is NOT silenced by the emulator's animation-scale
 * settings (window/transition/animator_duration_scale=0), matching how
 * Reanimated / JS-driven spinners behave. A setInterval-driven tick text
 * additionally guarantees a constant stream of content-changed events.
 *
 * The stable, visible, interactable targets the agent must still resolve
 * promptly are the status text (testID="animating-status") and the button
 * (testID="animating-stop").
 */
export default function AnimatingScreen() {
  const router = useRouter()
  const spin = useRef(new Animated.Value(0)).current
  const [tick, setTick] = useState(0)
  const [stopped, setStopped] = useState(false)

  // Continuous, JS-driven rotation that never settles.
  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    )
    animation.start()
    return () => animation.stop()
  }, [spin])

  // Constant content-changed events so the a11y stream never goes quiet.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 50)
    return () => clearInterval(id)
  }, [])

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  })

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Creating your story
      </Text>

      <Animated.Text style={[styles.butterfly, { transform: [{ rotate }] }]}>🦋</Animated.Text>

      <ActivityIndicator size="large" color="#007AFF" testID="animating-spinner" />

      {/* Decorative, constantly-changing text — keeps the UI perpetually busy. */}
      <Text style={styles.frames} accessibilityElementsHidden>
        frame {tick}
      </Text>

      <Text style={styles.status} testID="animating-status">
        {stopped ? "Stopped" : "Generating illustration"}
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => setStopped(true)}
        accessibilityRole="button"
        accessibilityLabel="Stop generation"
        testID="animating-stop"
      >
        <Text style={styles.buttonText}>Stop generation</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.secondaryButton]}
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        testID="animating-back"
      >
        <Text style={styles.buttonText}>Go back</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 24,
    color: "#1a1a1a",
  },
  butterfly: {
    fontSize: 64,
    marginBottom: 24,
  },
  frames: {
    fontSize: 12,
    color: "#bbb",
    marginTop: 8,
  },
  status: {
    fontSize: 16,
    color: "#333",
    marginTop: 16,
    marginBottom: 32,
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginBottom: 12,
    minWidth: 220,
    alignItems: "center",
  },
  secondaryButton: {
    backgroundColor: "#8E8E93",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
})
