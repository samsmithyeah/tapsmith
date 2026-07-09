import { Stack } from "expo-router"
import { StyleSheet, Text, View } from "react-native"
import { AuthProvider, useAuth } from "./auth-context"

/**
 * A tiny always-present text element whose content changes on every
 * resetAppState() call. Warm in-process deep-link delivery on iOS is verified
 * by requiring the a11y hierarchy to change from its pre-open state; a
 * `__reset?path=X` link that lands on the same screen the app was already
 * showing would otherwise produce an identical hierarchy and force the agent's
 * expensive cold-relaunch fallback (~15-22s per test on CI). Must stay
 * accessibility-visible: opacity 0 or aria-hidden would drop it from the
 * hierarchy dump and defeat the purpose.
 */
function ResetEpochMarker() {
  const { resetEpoch } = useAuth()
  return (
    <View pointerEvents="none" style={styles.epochMarker}>
      <Text style={styles.epochText} testID="reset-epoch">
        {`reset-epoch:${resetEpoch}`}
      </Text>
    </View>
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <View style={styles.container}>
        <Stack
          screenOptions={{
            headerBackTitle: "Back",
          }}
        >
          <Stack.Screen name="index" options={{ title: "Tapsmith Test App" }} />
          <Stack.Screen name="__reset" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: "Login Form" }} />
          <Stack.Screen name="profile" options={{ title: "Profile" }} />
          <Stack.Screen name="list" options={{ title: "List" }} />
          <Stack.Screen name="toggles" options={{ title: "Toggles" }} />
          <Stack.Screen name="spinner" options={{ title: "Spinner" }} />
          <Stack.Screen name="gestures" options={{ title: "Gestures", gestureEnabled: false }} />
          <Stack.Screen name="dialogs" options={{ title: "Dialogs" }} />
          <Stack.Screen name="visibility" options={{ title: "Visibility" }} />
          <Stack.Screen name="accessibility" options={{ title: "Accessibility" }} />
          <Stack.Screen name="permissions" options={{ title: "Permissions" }} />
          <Stack.Screen name="clipboard" options={{ title: "Clipboard" }} />
          <Stack.Screen name="keychain" options={{ title: "Keychain" }} />
          <Stack.Screen name="slow-load" options={{ title: "Slow Load" }} />
          <Stack.Screen name="animating" options={{ title: "Animating" }} />
          <Stack.Screen name="scroll" options={{ title: "Scroll" }} />
          <Stack.Screen name="api-calls" options={{ title: "API Calls" }} />
          <Stack.Screen name="webview" options={{ title: "WebView" }} />
        </Stack>
        <ResetEpochMarker />
      </View>
    </AuthProvider>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  epochMarker: {
    bottom: 2,
    position: "absolute",
    right: 4,
  },
  epochText: {
    color: "#c7c7c7",
    fontSize: 8,
  },
})
