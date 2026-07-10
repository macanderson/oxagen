"use client";

import { useEffect } from "react";

/**
 * Registers the app-shell service worker (apps/app/public/sw.js).
 *
 * Production only — Turbopack's dev server serves unhashed, constantly
 * changing chunk URLs, so registering a caching SW during `pnpm dev` would
 * fight live reload/HMR. No-ops silently wherever service workers aren't
 * supported and swallows registration failures (e.g. private browsing) —
 * the SW is a pure perceived-performance enhancement, never a requirement
 * for the app to function.
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures must never block the app — see comment above.
    });
  }, []);

  return null;
}
