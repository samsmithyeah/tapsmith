import { Tabs } from "expo-router"

/**
 * React Navigation bottom tabs (via expo-router). On Android each tab is a
 * generic View whose only role signal is React Native's "tab" role
 * description, which getByRole("tab") must read (PILOT-656).
 */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: "Library" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  )
}
