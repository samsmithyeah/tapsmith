/**
 * Hook for tracking elapsed time during test runs.
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';

export function useRunTimer() {
  const [runElapsed, setRunElapsed] = useState(0);
  const runStartRef = useRef<number>(0);
  const runTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRunTimer = useCallback(() => {
    if (runTimerRef.current) clearInterval(runTimerRef.current);
    runStartRef.current = Date.now();
    setRunElapsed(0);
    runTimerRef.current = setInterval(() => {
      setRunElapsed(Date.now() - runStartRef.current);
    }, 100);
  }, []);

  const stopRunTimer = useCallback(() => {
    if (runTimerRef.current) {
      clearInterval(runTimerRef.current);
      runTimerRef.current = null;
    }
  }, []);

  // Clean up on unmount
  useEffect(() => () => stopRunTimer(), [stopRunTimer]);

  return { runElapsed, startRunTimer, stopRunTimer };
}
