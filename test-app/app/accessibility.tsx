import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"

export default function AccessibilityScreen() {
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Accessibility Testing
      </Text>

      {/* Elements with roles */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Roles
      </Text>

      <TouchableOpacity
        style={styles.card}
        accessibilityRole="button"
        accessibilityLabel="Submit form"
        testID="role-button"
      >
        <Text style={styles.cardText}>Button role</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.card}
        accessibilityRole="link"
        accessibilityLabel="Visit website"
        testID="role-link"
      >
        <Text style={styles.cardText}>Link role</Text>
      </TouchableOpacity>

      <View
        style={styles.card}
        accessibilityRole="header"
        accessibilityLabel="Section header"
        testID="role-header"
      >
        <Text style={styles.cardText}>Header role</Text>
      </View>

      <View
        style={styles.card}
        accessibilityRole="image"
        accessibilityLabel="Profile photo"
        testID="role-image"
      >
        <Text style={styles.cardText}>Image role (placeholder)</Text>
      </View>

      <View
        style={styles.card}
        accessibilityRole="search"
        accessibilityLabel="Search results"
        testID="role-search"
      >
        <Text style={styles.cardText}>Search role</Text>
      </View>

      <View
        style={styles.card}
        accessibilityRole="alert"
        accessibilityLabel="Warning message"
        testID="role-alert"
      >
        <Text style={styles.cardText}>Alert role</Text>
      </View>

      {/* Content descriptions */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Content Descriptions
      </Text>

      <View style={styles.card} accessible accessibilityLabel="Close menu" testID="desc-close">
        <Text style={styles.cardText}>✕ (content description: Close menu)</Text>
      </View>

      <View
        style={styles.card}
        accessible
        accessibilityLabel="Shopping cart with 3 items"
        testID="desc-cart"
      >
        <Text style={styles.cardText}>🛒 (content description: Shopping cart with 3 items)</Text>
      </View>

      <View
        style={styles.card}
        accessible
        accessibilityLabel="User avatar"
        accessibilityHint="Double tap to view profile"
        testID="desc-avatar"
      >
        <Text style={styles.cardText}>👤 (label + hint)</Text>
      </View>

      {/* Accessibility states */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        States
      </Text>

      <TouchableOpacity
        style={[styles.card, styles.cardDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Disabled button"
        accessibilityState={{ disabled: true }}
        disabled
        testID="state-disabled"
      >
        <Text style={[styles.cardText, styles.textDisabled]}>Disabled button</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.card, styles.cardSelected]}
        accessibilityRole="button"
        accessibilityLabel="Selected item"
        accessibilityState={{ selected: true }}
        testID="state-selected"
      >
        <Text style={styles.cardText}>Selected item</Text>
      </TouchableOpacity>

      <View
        style={styles.card}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Upload progress"
        accessibilityValue={{ min: 0, max: 100, now: 65, text: "65%" }}
        testID="state-progress"
      >
        <Text style={styles.cardText}>Progress: 65%</Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: "65%" }]} />
        </View>
      </View>

      {/* Grouped elements */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Grouped Elements
      </Text>

      <View
        style={styles.card}
        accessible
        accessibilityLabel="John Doe, Software Engineer, Online"
        testID="grouped-profile"
      >
        <Text style={styles.cardTitle}>John Doe</Text>
        <Text style={styles.cardSubtitle}>Software Engineer</Text>
        <View style={styles.statusDot} />
        <Text style={styles.statusText}>Online</Text>
      </View>

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
  sectionHeader: {
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 20,
    marginBottom: 8,
    color: "#1a1a1a",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 14,
    marginBottom: 8,
  },
  cardDisabled: {
    backgroundColor: "#f0f0f0",
  },
  cardSelected: {
    backgroundColor: "#E8F4FD",
    borderWidth: 1,
    borderColor: "#007AFF",
  },
  cardText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  textDisabled: {
    color: "#999",
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#1a1a1a",
  },
  cardSubtitle: {
    fontSize: 14,
    color: "#666",
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#34C759",
    position: "absolute",
    right: 14,
    top: 14,
  },
  statusText: {
    fontSize: 12,
    color: "#34C759",
    marginTop: 4,
  },
  progressBar: {
    height: 8,
    backgroundColor: "#f0f0f0",
    borderRadius: 4,
    marginTop: 8,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#007AFF",
    borderRadius: 4,
  },
  spacer: {
    height: 32,
  },
})
