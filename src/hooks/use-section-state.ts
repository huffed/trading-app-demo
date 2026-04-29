"use client";

import { useEffect, useState } from "react";

/**
 * Per-key collapsible-section persistence. Reads/writes to localStorage
 * so the operator's "I always check the History section" preference
 * survives reloads. Defaults are honored on first visit.
 *
 * Returns `[expanded, toggle, setExpanded]` so callers can drive the
 * state from a button click (toggle) or a programmatic action
 * (setExpanded(true) when a deep-link asks for a specific section).
 */
export function useSectionState(
  key: string,
  defaultExpanded: boolean
): [boolean, () => void, (next: boolean) => void] {
  // Lazy initial state: read from localStorage on first render. Wrapped
  // in a function so the read happens once, not on every render.
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultExpanded;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return defaultExpanded;
      return raw === "true";
    } catch {
      return defaultExpanded;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, String(expanded));
    } catch {
      /* localStorage quota / disabled — silently no-op */
    }
  }, [key, expanded]);

  const toggle = () => setExpanded((v) => !v);
  return [expanded, toggle, setExpanded];
}
