import { Stack } from "expo-router"
import { AuthProvider } from "./auth-context"

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack
        screenOptions={{
          headerBackTitle: "Back",
        }}
      >
        <Stack.Screen name="index" options={{ title: "Pilot Test App" }} />
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
        <Stack.Screen name="slow-load" options={{ title: "Slow Load" }} />
        <Stack.Screen name="scroll" options={{ title: "Scroll" }} />
        <Stack.Screen name="api-calls" options={{ title: "API Calls" }} />
      </Stack>
    </AuthProvider>
  )
}
