import { type Href, router, useLocalSearchParams } from "expo-router"
import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, StyleSheet, Text, View } from "react-native"
import { useAuth } from "./auth-context"

function normalizeTarget(value: string | string[] | undefined): Href {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return "/"

  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith("/") && !decoded.startsWith("//") && !decoded.startsWith("/__reset")) {
      return decoded as Href
    }
  } catch {
    // Fall through to the safe default route.
  }

  return "/"
}

export default function ResetScreen() {
  const params = useLocalSearchParams<{ path?: string | string[] }>()
  const target = useMemo(() => normalizeTarget(params.path), [params.path])
  const [resetError, setResetError] = useState<string | null>(null)
  const { resetAppState } = useAuth()

  useEffect(() => {
    let mounted = true
    async function reset() {
      try {
        await resetAppState()
        if (!mounted) return
        router.dismissAll()
        router.replace(target)
      } catch (error) {
        if (!mounted) return
        setResetError(error instanceof Error ? error.message : String(error))
      }
    }

    void reset()

    return () => {
      mounted = false
    }
  }, [resetAppState, target])

  return (
    <View
      style={styles.container}
      accessibilityElementsHidden={!resetError}
      importantForAccessibility={resetError ? "auto" : "no-hide-descendants"}
    >
      {resetError ? (
        <Text style={styles.errorText} testID="reset-error">
          Reset failed: {resetError}
        </Text>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: "#f5f5f5",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  errorText: {
    color: "#FF3B30",
    fontSize: 16,
    textAlign: "center",
  },
})
