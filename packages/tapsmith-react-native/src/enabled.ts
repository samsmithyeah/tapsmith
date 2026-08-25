/**
 * Test hooks belong in test builds only. The default gate is `__DEV__` (dev
 * clients, Expo Go, `expo start`) or the explicit build-time flag
 * `EXPO_PUBLIC_TAPSMITH_HOOKS=1` (release builds made for e2e). Production
 * builds without the flag render nothing and register no listener.
 *
 * The env access must be the literal `process.env.EXPO_PUBLIC_TAPSMITH_HOOKS`
 * member expression: Expo's Babel preset inlines `process.env.EXPO_PUBLIC_*`
 * at bundle time and a dynamic lookup stays `undefined` in a release bundle.
 */
declare const __DEV__: boolean | undefined;
// React Native provides a minimal `process.env`; declared here so the package needs no Node types.
declare const process: { env?: Record<string, string | undefined> } | undefined;

export function hooksEnabledByDefault(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === '1' || process.env.TAPSMITH_HOOKS === '1';
}
