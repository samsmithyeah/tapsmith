import { useState, useCallback } from 'preact/hooks';

type Serializer<T> = {
  serialize: (value: T) => string
  deserialize: (raw: string) => T
}

const identity: Serializer<string> = {
  serialize: (v) => v,
  deserialize: (v) => v,
};

function usePersistedState<T>(
  key: string,
  defaultValue: T,
  serializer?: Serializer<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  const s = serializer;
  const [value, _setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw != null) return s ? s.deserialize(raw) : raw as T;
    } catch { /* ignore */ }
    return defaultValue;
  });

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    _setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
      try {
        const raw = s ? s.serialize(resolved) : resolved as unknown as string;
        sessionStorage.setItem(key, raw);
      } catch { /* quota or SSR */ }
      return resolved;
    });
  }, [key, s]);

  return [value, setValue];
}

export function usePersistedString(key: string, defaultValue: string): [string, (v: string) => void] {
  return usePersistedState(key, defaultValue, identity);
}

const jsonSerializer = <T>(): Serializer<T> => ({
  serialize: (v) => JSON.stringify(v),
  deserialize: (raw) => JSON.parse(raw) as T,
});

export function usePersistedJSON<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  return usePersistedState(key, defaultValue, jsonSerializer<T>());
}
