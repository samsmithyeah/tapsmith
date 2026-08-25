# @tapsmith/react-native

In-app reset hooks for [Tapsmith](https://tapsmith.dev). One line in your app's root turns Tapsmith's between-test app reset from a cold relaunch (7–13 s on an iOS simulator) into an acknowledged in-process reset (well under a second) — and lets Tapsmith isolate **every test** by default instead of every file.

```tsx
// app/_layout.tsx (Expo Router) — or your root component
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { TapsmithTestHooks } from '@tapsmith/react-native';

export default function RootLayout() {
  return (
    <>
      <Stack />
      <TapsmithTestHooks urlPrefix={Linking.createURL('/')} clear={[AsyncStorage]} />
    </>
  );
}
```

- `clear` — stores to wipe on every reset (anything with `clear()` or `clearAll()`, e.g. AsyncStorage, MMKV).
- `onReset` — your own reset (sign out, drop in-memory state, reset navigation).
- `urlPrefix` / `scheme` — how Tapsmith should build reset links into your app. Expo: `Linking.createURL('/')`; bare React Native: `scheme="myapp"`.
- `enabled` — defaults to `__DEV__` **or** the build-time flag `EXPO_PUBLIC_TAPSMITH_HOOKS=1` (release builds made for e2e). Production builds without the flag render nothing.

Tapsmith detects the hooks automatically — no config changes. See the [Warm app reset guide](https://tapsmith.dev/guides/warm-reset/).

Never enable the hooks in a production build: a reset link can clear local storage and navigate the app.
