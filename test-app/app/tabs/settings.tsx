import { StyleSheet, Text, View } from "react-native"

export default function SettingsTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.text} testID="tab-content">
        Settings content
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 18 },
})
