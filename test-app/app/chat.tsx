import { useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// A screen two app instances share state through: messages live on a tiny
// HTTP server the e2e test starts on the host (`GET/POST <server>/messages`),
// so a test driving two devices at once (PILOT-310) can have one user send a
// message and assert the other sees it. `server` is taken from the deep link
// (`tapsmithtest:///chat?server=http://10.0.2.2:PORT`) or typed in; the
// default points at the host machine from an emulator / simulator.

interface Message {
  id: number
  name: string
  text: string
}

const DEFAULT_SERVER = Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787"

function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ server?: string | string[] }>()
  const [server, setServer] = useState(firstParam(params.server) ?? DEFAULT_SERVER)
  const [name, setName] = useState("")
  const [joined, setJoined] = useState(false)
  const [text, setText] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState("")
  const listRef = useRef<ScrollView>(null)

  // A deep link that carries a server while the screen is already mounted
  // (a warm reset landing here) must win over whatever was typed before.
  useEffect(() => {
    const fromLink = firstParam(params.server)
    if (fromLink) setServer(fromLink)
  }, [params.server])

  // The warm reset navigates rather than remounting; component-local state
  // survives it, so leave the conversation explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setJoined(false)
    setName("")
    setText("")
    setMessages([])
    setError("")
  }, [resetEpoch])

  // Poll while joined. A failed poll is reported once and retried; the
  // conversation is the only thing on screen, so it has to keep trying.
  useEffect(() => {
    if (!joined) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`${server}/messages`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as Message[]
        if (!cancelled) {
          setMessages(data)
          setError("")
        }
      } catch (e) {
        if (!cancelled) setError(`Could not reach ${server}: ${e instanceof Error ? e.message : e}`)
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [joined, server])

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: false })
  }, [messages.length])

  const cleanName = name.trim().replace(/^"|"$/g, "")

  const send = async () => {
    const cleanText = text.trim().replace(/^"|"$/g, "")
    if (!cleanText) return
    setText("")
    try {
      const res = await fetch(`${server}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: cleanName, text: cleanText }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as Message[]
      setMessages(data)
      setError("")
    } catch (e) {
      setError(`Could not send: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading} accessibilityRole="header">
          Chat
        </Text>
        <Text style={styles.description}>
          Messages are shared through a server on the host, so two devices can talk.
        </Text>

        {!joined ? (
          <>
            <Text style={styles.label}>Server</Text>
            <TextInput
              style={styles.input}
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              accessibilityLabel="Server"
              testID="chat-server"
            />
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Who are you?"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              accessibilityLabel="Name"
              testID="chat-name"
            />
            <TouchableOpacity
              style={[styles.button, !cleanName && styles.buttonDisabled]}
              onPress={() => setJoined(true)}
              accessibilityRole="button"
              accessibilityLabel="Join"
              accessibilityState={{ disabled: !cleanName }}
              disabled={!cleanName}
              testID="chat-join"
            >
              <Text style={styles.buttonText}>Join</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.joinedAs} testID="chat-joined-as">
              Chatting as {cleanName}
            </Text>
            <View style={styles.messages} testID="chat-messages">
              <ScrollView ref={listRef} nestedScrollEnabled>
                {messages.length === 0 ? (
                  <Text style={styles.emptyText}>No messages yet</Text>
                ) : (
                  messages.map((m) => {
                    const line = `${m.name}: ${m.text}`
                    return (
                      <Text
                        key={m.id}
                        style={[styles.message, m.name === cleanName && styles.ownMessage]}
                        accessibilityLabel={line}
                        testID={`chat-message-${m.id}`}
                      >
                        {line}
                      </Text>
                    )
                  })
                )}
              </ScrollView>
            </View>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Type a message"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              returnKeyType="send"
              onSubmitEditing={send}
              accessibilityLabel="Message"
              testID="chat-message-input"
            />
            <TouchableOpacity
              style={styles.button}
              onPress={send}
              accessibilityRole="button"
              accessibilityLabel="Send"
              testID="chat-send"
            >
              <Text style={styles.buttonText}>Send</Text>
            </TouchableOpacity>
          </>
        )}

        {error ? (
          <Text style={styles.errorText} accessibilityRole="alert" testID="chat-error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  content: {
    padding: 20,
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: "#666",
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
    color: "#333",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  buttonDisabled: {
    backgroundColor: "#99c2f5",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  joinedAs: {
    fontSize: 14,
    color: "#666",
    marginBottom: 12,
  },
  messages: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    height: 220,
    marginBottom: 16,
  },
  message: {
    fontSize: 16,
    paddingVertical: 4,
    color: "#333",
  },
  ownMessage: {
    color: "#007AFF",
  },
  emptyText: {
    fontSize: 14,
    color: "#999",
  },
  errorText: {
    color: "#FF3B30",
    fontSize: 14,
    marginTop: 8,
  },
})
