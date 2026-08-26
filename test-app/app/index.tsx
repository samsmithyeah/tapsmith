import { Link } from "expo-router"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

const screens = [
  {
    href: "/login",
    label: "Login Form",
    description: "Text inputs, buttons, focus/blur, keyboard",
  },
  { href: "/list", label: "List", description: "Scrollable list, filtering, counting items" },
  { href: "/toggles", label: "Toggles", description: "Checkboxes, switches, radio buttons" },
  { href: "/spinner", label: "Spinner", description: "Dropdown/spinner selection" },
  {
    href: "/gestures",
    label: "Gestures",
    description: "Drag, pinch, swipe, double-tap, long-press",
  },
  { href: "/dialogs", label: "Dialogs", description: "Alerts, toasts, snackbars" },
  { href: "/visibility", label: "Visibility", description: "Show/hide, conditional rendering" },
  { href: "/accessibility", label: "Accessibility", description: "Roles, labels, descriptions" },
  { href: "/permissions", label: "Permissions", description: "Runtime permission requests" },
  { href: "/clipboard", label: "Clipboard", description: "Copy and paste" },
  { href: "/keychain", label: "Keychain", description: "Secure storage (keychain/keystore)" },
  { href: "/slow-load", label: "Slow Load", description: "Simulated loading delays" },
  {
    href: "/animating",
    label: "Animating",
    description: "Never-idle screen — continuous animation + indeterminate spinner",
  },
  { href: "/scroll", label: "Scroll", description: "Nested scrollable containers" },
  { href: "/api-calls", label: "API Calls", description: "Real HTTP requests to a test API" },
  {
    href: "/webview",
    label: "WebView",
    description: "Embedded web content interaction",
  },
  {
    href: "/profile",
    label: "Profile",
    description: "Auth-gated screen — requires login",
  },
] as const

export default function HomeScreen() {
  // Component-local state (here: the scroll offset) survives the warm reset's
  // navigation; keying by the reset epoch remounts the list at the top.
  const resetEpoch = useTapsmithResetEpoch()
  return (
    <ScrollView key={resetEpoch} style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Test Screens
      </Text>
      {screens.map((screen) => (
        <Link key={screen.href} href={screen.href} asChild>
          <Pressable
            style={styles.card}
            accessibilityRole="button"
            accessibilityLabel={screen.label}
          >
            <Text style={styles.cardTitle}>{screen.label}</Text>
            <Text style={styles.cardDescription}>{screen.description}</Text>
          </Pressable>
        </Link>
      ))}
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
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1a1a1a",
    marginBottom: 4,
  },
  cardDescription: {
    fontSize: 14,
    color: "#666",
  },
  spacer: {
    height: 32,
  },
})
