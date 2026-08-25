/**
 * Test hooks belong in test builds only. The default gate is `__DEV__` (dev
 * clients, Expo Go, `expo start`) or the explicit build-time flag
 * `EXPO_PUBLIC_TAPSMITH_HOOKS=1` (release builds made for e2e). Production
 * builds without the flag render nothing and register no listener.
 */
export function hooksEnabledByDefault(): boolean {
  const g = globalThis as { __DEV__?: boolean; process?: { env?: Record<string, string | undefined> } };
  if (g.__DEV__ === true) return true;
  const env = g.process?.env;
  return env?.EXPO_PUBLIC_TAPSMITH_HOOKS === '1' || env?.TAPSMITH_HOOKS === '1';
}
