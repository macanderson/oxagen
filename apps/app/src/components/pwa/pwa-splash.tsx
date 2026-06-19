"use client";

/**
 * PWA splash overlay — shown only when the app is launched from the installed
 * home-screen shortcut (standalone / minimal-ui display mode). Gate is pure CSS
 * so the overlay is visible on the very first paint, before any JS runs. A
 * client effect dismisses it after hydration by toggling `data-loaded`.
 *
 * No data fetching, no heavy deps — intentionally dependency-free.
 */

import { useEffect, useRef } from "react";
import styles from "./pwa-splash.module.css";

export function PwaSplash() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // iOS Safari standalone exposes `navigator.standalone` but does NOT reliably
    // match the `display-mode: standalone` media query the CSS gate relies on.
    // Set the attribute so the overlay still renders on an iOS home-screen launch.
    const iosStandalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (iosStandalone) {
      el.dataset.standalone = "true";
    }

    // Dismiss after a short ramp so the app content is visible before we fade.
    // requestAnimationFrame ensures the browser has painted at least one frame.
    const raf = requestAnimationFrame(() => {
      el.dataset.loaded = "true";
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      className={styles.splash}
      aria-hidden="true"
      role="presentation"
    >
      {/* Dark-variant spinner for the dark background (#0B0D16).
          Light variant shown via CSS when the system prefers light. */}
      <img
        src="/pwa/oxagen-spinner-assemble-dark.gif"
        alt=""
        width={64}
        height={64}
        className={styles.spinnerDark}
        aria-hidden="true"
      />
      <img
        src="/pwa/oxagen-spinner-assemble-light.gif"
        alt=""
        width={64}
        height={64}
        className={styles.spinnerLight}
        aria-hidden="true"
      />
    </div>
  );
}
