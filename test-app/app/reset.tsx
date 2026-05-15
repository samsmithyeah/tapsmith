import AsyncStorage from "@react-native-async-storage/async-storage"
import { useRouter } from "expo-router"
import { useEffect } from "react"
import { View } from "react-native"

export default function ResetScreen() {
  const router = useRouter()

  useEffect(() => {
    AsyncStorage.clear().then(() => {
      router.replace("/")
    })
  }, [router])

  return <View />
}
