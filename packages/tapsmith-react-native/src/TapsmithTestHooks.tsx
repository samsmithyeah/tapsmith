import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { formatMarker, parseResetRequest, resetDedupeKey, BOOT_TOKEN } from './protocol.js';
import { publishResetEpoch } from './epoch.js';
import { hooksEnabledByDefault } from './enabled.js';
import { registeredHandlers, runResetPipeline, type Clearable, type ResetHandler } from './reset.js';

export interface TapsmithTestHooksProps {
  /**
   * Runs on every reset request, after `clear`. Put your app's own reset here
   * (sign out, drop in-memory caches, reset navigation state).
   */
  onReset?: ResetHandler;
  /**
   * Stores to wipe on reset, e.g. `[AsyncStorage]` or `[storage]` (MMKV).
   * Passed in rather than imported so the package has no dependency on any
   * particular storage library (Metro cannot bundle optional imports).
   */
  clear?: readonly Clearable[];
  /**
   * URL prefix Tapsmith should build reset links from — must route into this
   * app. Expo: `Linking.createURL('/')` from `expo-linking` (handles Expo Go
   * and standalone builds). Bare React Native: `'myapp://'`.
   */
  urlPrefix?: string;
  /** Bare React Native shorthand for `urlPrefix={`${scheme}://`}`. */
  scheme?: string;
  /**
   * Force the hooks on or off. Default: `__DEV__`, or
   * `EXPO_PUBLIC_TAPSMITH_HOOKS=1` at build time (release builds for e2e).
   */
  enabled?: boolean;
}

/**
 * Mount once at the root of the app. Renders a tiny, always-present marker in
 * the accessibility tree that tells Tapsmith the app can be reset in-process
 * (and acknowledges each reset by bumping an epoch), and listens for the
 * reset deep links Tapsmith opens.
 *
 * Renders nothing and registers nothing when disabled (production).
 */
export function TapsmithTestHooks({ onReset, clear = [], urlPrefix, scheme, enabled }: TapsmithTestHooksProps) {
  const active = enabled ?? hooksEnabledByDefault();
  const [epoch, setEpoch] = useState(0);
  const [nav, setNav] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const seenNonces = useRef(new Set<string>());
  const initialUrlHandled = useRef(false);
  const latest = useRef({ onReset, clear });
  latest.current = { onReset, clear };

  const prefix = normalisePrefix(urlPrefix ?? (scheme ? `${scheme}://` : ''));

  useEffect(() => {
    if (!active) return;
    let disposed = false;

    // `initial`: the cold-launch URL. It is read once for the component's
    // lifetime (see below) but resolves asynchronously — under StrictMode
    // (and any `enabled` toggle) this effect's first pass is already disposed
    // by then, so that URL must be honoured regardless of `disposed` or a
    // cold-delivered reset is silently dropped.
    const handle = async (url: string | null, initial = false) => {
      if (!url || (disposed && !initial)) return;
      // Every received URL bumps `nav` — the ack for plain navigation deep
      // links (a same-screen link changes nothing else observable).
      setNav((n) => n + 1);
      const request = parseResetRequest(url);
      if (!request) return;
      // A dropped-and-refired intent must not reset twice. Bounded: only
      // recent entries matter for redelivery.
      const dedupeKey = resetDedupeKey(request, url);
      if (seenNonces.current.has(dedupeKey)) return;
      seenNonces.current.add(dedupeKey);
      while (seenNonces.current.size > 64) {
        seenNonces.current.delete(seenNonces.current.values().next().value as string);
      }
      try {
        const handlers: ResetHandler[] = [...(latest.current.onReset ? [latest.current.onReset] : []), ...registeredHandlers()];
        await runResetPipeline(request, latest.current.clear, handlers);
        if (disposed && !initial) return;
        setError(undefined);
      } catch (err) {
        if (disposed && !initial) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      // Always advance the epoch so Tapsmith never waits on a failed reset;
      // the error rides along in the marker.
      setEpoch((e) => e + 1);
    };

    const sub = Linking.addEventListener('url', ({ url }) => { void handle(url); });
    // A cold launch delivers the URL before any listener exists. Count it
    // once: a re-run of this effect (`enabled` toggled) re-reads the same
    // initial URL, which must not bump `nav` again.
    if (!initialUrlHandled.current) {
      initialUrlHandled.current = true;
      Linking.getInitialURL().then((url) => { void handle(url, true); }, () => { /* ignore */ });
    }
    return () => {
      disposed = true;
      sub.remove();
    };
  }, [active]);

  // Screens keyed by useTapsmithResetEpoch() remount with the marker. Published
  // from an effect, not the state updater: an update issued to another
  // component while this one renders is deferred or dropped by React.
  useEffect(() => { publishResetEpoch(epoch); }, [epoch]);

  if (!active) return null;

  return (
    <View pointerEvents="none" style={styles.marker} accessibilityElementsHidden={false} importantForAccessibility="yes">
      <Text testID="tapsmith-hooks" style={styles.text}>
        {formatMarker({ epoch, nav, boot: BOOT_TOKEN, urlPrefix: prefix, error })}
      </Text>
    </View>
  );
}

function normalisePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

const styles = StyleSheet.create({
  marker: {
    bottom: 2,
    position: 'absolute',
    right: 4,
  },
  text: {
    color: '#c7c7c7',
    fontSize: 8,
  },
});
