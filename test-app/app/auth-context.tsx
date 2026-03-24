import AsyncStorage from "@react-native-async-storage/async-storage"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export const AUTH_KEY = "pilot_auth_email"

interface AuthState {
  email: string | null
  loading: boolean
  login: (email: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  email: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      if (stored) setEmail(stored)
      setLoading(false)
    })
  }, [])

  const login = async (newEmail: string) => {
    await AsyncStorage.setItem(AUTH_KEY, newEmail)
    setEmail(newEmail)
  }

  const logout = async () => {
    await AsyncStorage.removeItem(AUTH_KEY)
    setEmail(null)
  }

  return (
    <AuthContext.Provider value={{ email, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
