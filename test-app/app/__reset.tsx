import { type Href, router, useLocalSearchParams } from "expo-router"
import { useEffect, useMemo, useRef } from "react"
import { ActivityIndicator, StyleSheet, View } from "react-native"
import { useAuth } from "./auth-context"

function normalizeTarget(value: string | string[] | undefined): Href {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return "/"

  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith("/") && !decoded.startsWith("//")) {
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
  const didReset = useRef(false)
  const { resetAppState } = useAuth()

  useEffect(() => {
    if (didReset.current) return
    didReset.current = true

    let mounted = true
    async function reset() {
      await resetAppState()
      if (!mounted) return
      router.dismissAll()
      router.replace(target)
    }

    void reset()

    return () => {
      mounted = false
    }
  }, [resetAppState, target])

  return (
    <View
      style={styles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ActivityIndicator />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: "#f5f5f5",
    flex: 1,
    justifyContent: "center",
  },
})
