import { useState } from "react"
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"

const COUNTRIES = [
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Germany",
  "France",
  "Japan",
]
const COLORS = ["Red", "Green", "Blue", "Yellow", "Purple", "Orange"]
const PRIORITIES = ["Low", "Medium", "High", "Critical"]

interface DropdownProps {
  label: string
  options: string[]
  selected: string
  onSelect: (value: string) => void
  testID: string
}

function Dropdown({ label, options, selected, onSelect, testID }: DropdownProps) {
  const [open, setOpen] = useState(false)

  return (
    <View style={styles.dropdownContainer}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={styles.dropdownButton}
        onPress={() => setOpen(!open)}
        accessibilityRole="combobox"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        testID={testID}
      >
        <Text style={styles.dropdownText}>{selected || "Select..."}</Text>
        <Text style={styles.dropdownArrow}>{open ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.optionsList} accessibilityRole="list">
          {options.map((option, index) => (
            <TouchableOpacity
              key={option}
              style={[styles.option, selected === option && styles.optionSelected]}
              onPress={() => {
                onSelect(option)
                setOpen(false)
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={option}
              accessibilityState={{ selected: selected === option }}
              testID={`${testID}-option-${index}`}
            >
              <Text style={[styles.optionText, selected === option && styles.optionTextSelected]}>
                {option}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  )
}

export default function SpinnerScreen() {
  const [country, setCountry] = useState("")
  const [color, setColor] = useState("")
  const [priority, setPriority] = useState("")

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Dropdowns
      </Text>

      <Dropdown
        label="Country"
        options={COUNTRIES}
        selected={country}
        onSelect={setCountry}
        testID="country-dropdown"
      />

      <Dropdown
        label="Favorite Color"
        options={COLORS}
        selected={color}
        onSelect={setColor}
        testID="color-dropdown"
      />

      <Dropdown
        label="Priority"
        options={PRIORITIES}
        selected={priority}
        onSelect={setPriority}
        testID="priority-dropdown"
      />

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Selected Values
      </Text>
      <Text style={styles.value} testID="selected-country">
        Country: {country || "None"}
      </Text>
      <Text style={styles.value} testID="selected-color">
        Color: {color || "None"}
      </Text>
      <Text style={styles.value} testID="selected-priority">
        Priority: {priority || "None"}
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
    marginBottom: 16,
    color: "#1a1a1a",
  },
  sectionHeader: {
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 24,
    marginBottom: 8,
    color: "#1a1a1a",
  },
  dropdownContainer: {
    marginBottom: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 6,
    color: "#333",
  },
  dropdownButton: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dropdownText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  dropdownArrow: {
    fontSize: 12,
    color: "#666",
  },
  optionsList: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  option: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  optionSelected: {
    backgroundColor: "#E8F4FD",
  },
  optionText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  optionTextSelected: {
    color: "#007AFF",
    fontWeight: "600",
  },
  value: {
    fontSize: 14,
    color: "#666",
    paddingVertical: 4,
  },
  spacer: {
    height: 32,
  },
})
