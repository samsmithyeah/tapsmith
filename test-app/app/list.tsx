import { useState } from "react"
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native"

const ITEMS = Array.from({ length: 30 }, (_, i) => ({
  id: String(i + 1),
  title: `Item ${i + 1}`,
  category: i % 3 === 0 ? "Premium" : i % 3 === 1 ? "Standard" : "Basic",
  price: `$${((i + 1) * 9.99).toFixed(2)}`,
}))

export default function ListScreen() {
  const [filter, setFilter] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const filtered = ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(filter.toLowerCase()) ||
      item.category.toLowerCase().includes(filter.toLowerCase()),
  )

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchInput}
        value={filter}
        onChangeText={setFilter}
        placeholder="Search items..."
        accessibilityLabel="Search"
        accessibilityHint="Filter the list by name or category"
        testID="search-input"
      />

      <Text style={styles.countText} testID="item-count">
        {filtered.length} items
      </Text>

      <Text style={styles.countText} testID="selected-count">
        {selectedIds.size} selected
      </Text>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        accessibilityRole="list"
        accessibilityLabel="Shopping list"
        renderItem={({ item }) => {
          const isSelected = selectedIds.has(item.id)
          return (
            <TouchableOpacity
              style={[styles.item, isSelected && styles.itemSelected]}
              onPress={() => toggleSelect(item.id)}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{ selected: isSelected }}
              testID={`item-${item.id}`}
            >
              <View style={styles.itemContent}>
                <Text style={styles.itemTitle}>{item.title}</Text>
                <Text style={styles.itemCategory}>{item.category}</Text>
              </View>
              <Text style={styles.itemPrice}>{item.price}</Text>
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  searchInput: {
    backgroundColor: "#fff",
    margin: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    fontSize: 16,
  },
  countText: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    color: "#666",
    fontSize: 14,
  },
  item: {
    backgroundColor: "#fff",
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  itemSelected: {
    backgroundColor: "#E8F4FD",
    borderWidth: 1,
    borderColor: "#007AFF",
  },
  itemContent: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  itemCategory: {
    fontSize: 13,
    color: "#888",
    marginTop: 2,
  },
  itemPrice: {
    fontSize: 16,
    fontWeight: "600",
    color: "#007AFF",
  },
})
