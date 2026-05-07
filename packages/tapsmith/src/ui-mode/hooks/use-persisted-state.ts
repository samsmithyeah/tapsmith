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
): [T, (value: T) => void] {
  const s = serializer as Serializer<T> | undefined;
  const [value, _setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw != null) return s ? s.deserialize(raw) : raw as T;
    } catch { /* ignore */ }
    return defaultValue;
  });

  const setValue = useCallback((next: T) => {
    _setValue(next);
    try {
      const raw = s ? s.serialize(next) : next as unknown as string;
      sessionStorage.setItem(key, raw);
    } catch { /* quota or SSR */ }
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
