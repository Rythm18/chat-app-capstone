import { useEffect, useState } from "react";

/**
 * Ticking clock: returns the current epoch ms, refreshed every `intervalMs`
 * while `active` is true. Elapsed-time labels read it so running nodes count
 * up live instead of freezing until the next stream event re-renders them.
 * Inactive components pay nothing — the interval only exists while running.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
