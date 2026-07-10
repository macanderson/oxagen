"use client";

import { useEffect } from "react";

/**
 * Registers the docs-shell service worker (apps/docs/public/sw.js).
 *
 * Production only — Turbopack's dev server serves unhashed, constantly
 * changing chunk URLs, so registering a caching SW during `pnpm dev` would
 * fight live reload/HMR. No-ops silently wherever service workers aren't
 * supported and swallows registration failures — the SW is a pure
 * perceived-performance enhancement, never a requirement for the site to
 * function.
 *
 * Note: apps/docs has no vitest harness yet (no vitest.config.* in this
 * package), so this component is intentionally left without a colocated
 * unit test — see apps/app/src/components/pwa/sw-register.test.tsx for the
 * equivalent coverage in the app that already has a test harness wired up.
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures must never block the site — see comment above.
    });
  }, []);

  return null;
}
