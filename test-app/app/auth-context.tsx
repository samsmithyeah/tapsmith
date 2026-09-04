import AsyncStorage from "@react-native-async-storage/async-storage"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

export const AUTH_KEY = "tapsmith_auth_email"

interface AuthState {
  email: string | null
  loading: boolean
  /**
   * Counts completed resetAppState() calls in this process. Consumers can key
   * on it to remount after a reset; the Tapsmith hooks marker (see
   * `@tapsmith/react-native`) carries its own epoch for the harness.
   */
  resetEpoch: number
  login: (email: string) => Promise<void>
  logout: () => Promise<void>
  resetAppState: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  email: null,
  loading: true,
  resetEpoch: 0,
  login: async () => {},
  logout: async () => {},
  resetAppState: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetEpoch, setResetEpoch] = useState(0)
  const loadGeneration = useRef(0)

  useEffect(() => {
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      if (loadGeneration.current !== generation) return
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

  const resetAppState = useCallback(async () => {
    loadGeneration.current += 1
    await AsyncStorage.clear()
    setEmail(null)
    setLoading(false)
    setResetEpoch((epoch) => epoch + 1)
  }, [])

  return (
    <AuthContext.Provider value={{ email, loading, resetEpoch, login, logout, resetAppState }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
