import { useState } from "react"
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useAuth } from "./auth-context"

export default function LoginScreen() {
  const { email: authEmail, login, logout } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")

  const handleSubmit = async () => {
    setError("")
    // Strip surrounding quotes — workaround for PILOT-133 where type() wraps text in quotes
    const cleanEmail = email.trim().replace(/^"|"$/g, "")
    const cleanPassword = password.trim().replace(/^"|"$/g, "")
    if (!cleanEmail) {
      setError("Email is required")
      return
    }
    if (!cleanPassword) {
      setError("Password is required")
      return
    }
    if (cleanEmail.includes("test@example.com") && cleanPassword.includes("password123")) {
      await login(cleanEmail)
    } else {
      setError("Invalid credentials")
    }
  }

  const handleReset = async () => {
    setEmail("")
    setPassword("")
    setError("")
    await logout()
  }

  if (authEmail) {
    return (
      <View style={styles.container}>
        <Text style={styles.successText} accessibilityRole="text" testID="success-message">
          Login successful!
        </Text>
        <Text style={styles.welcomeText}>Welcome, {authEmail}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={handleReset}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Text style={styles.buttonText}>Log out</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.form}>
        <Text style={styles.heading} accessibilityRole="header">
          Sign In
        </Text>

        {error ? (
          <Text style={styles.errorText} accessibilityRole="alert" testID="error-message">
            {error}
          </Text>
        ) : null}

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Enter your email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          accessibilityLabel="Email"
          accessibilityHint="Enter your email address"
          testID="email-input"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Enter your password"
          secureTextEntry
          accessibilityLabel="Password"
          accessibilityHint="Enter your password"
          testID="password-input"
        />

        <TouchableOpacity
          style={[styles.button, (!email || !password) && styles.buttonDisabled]}
          onPress={handleSubmit}
          accessibilityRole="button"
          accessibilityLabel="Sign in"
          accessibilityState={{ disabled: !email || !password }}
          disabled={!email || !password}
        >
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.linkButton}
          onPress={() => Alert.alert("Reset", "Password reset not implemented")}
          accessibilityRole="link"
          accessibilityLabel="Forgot password"
        >
          <Text style={styles.linkText}>Forgot password?</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  form: {
    padding: 24,
  },
  heading: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 24,
    color: "#1a1a1a",
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 6,
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
    padding: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    backgroundColor: "#999",
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
  linkButton: {
    marginTop: 16,
    alignItems: "center",
  },
  linkText: {
    color: "#007AFF",
    fontSize: 16,
  },
  successText: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#34C759",
    textAlign: "center",
    marginTop: 60,
  },
  welcomeText: {
    fontSize: 18,
    color: "#666",
    textAlign: "center",
    marginTop: 8,
    marginBottom: 24,
  },
  errorText: {
    color: "#FF3B30",
    fontSize: 14,
    marginBottom: 12,
    padding: 8,
    backgroundColor: "#FFF0F0",
    borderRadius: 6,
  },
})
