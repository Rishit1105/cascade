import { useEffect, useState } from "react";

/** Live result of a CSS media query (e.g. prefers-reduced-motion). */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
