"use client";

/* eslint-disable @next/next/no-img-element -- animated GIF spinners (dark/light); next/image freezes and mis-optimizes animated GIFs, so a plain <img> is intentional here. */

/**
 * PWA splash overlay — shown only when the app is launched from the installed
 * home-screen shortcut (standalone / minimal-ui display mode). Gate is pure CSS
 * so the overlay is visible on the very first paint, before any JS runs. A
 * client effect dismisses it after hydration by toggling `data-loaded`.
 *
 * No data fetching, no heavy deps — intentionally dependency-free.
 */

import { useEffect, useRef, useState } from "react";
import styles from "./pwa-splash.module.css";

export function PwaSplash() {
  const ref = useRef<HTMLDivElement>(null);
  const [imgFailed, setImgFailed] = useState<boolean>(false);

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
      {/* Dark-variant spinner for the dark background (#0A0A0C).
          Light variant shown via CSS when the system prefers light.
          Falls back to a pure-CSS ring if either GIF fails to load. */}
      {imgFailed ? (
        <span className={styles.cssSpinner} aria-hidden="true" />
      ) : (
        <>
          <img
            src="/spinner/oxagen-spinner-assemble-dark.gif"
            alt=""
            width={64}
            height={64}
            className={styles.spinnerDark}
            aria-hidden="true"
            onError={() => setImgFailed(true)}
          />
          <img
            src="/spinner/oxagen-spinner-assemble-light.gif"
            alt=""
            width={64}
            height={64}
            className={styles.spinnerLight}
            aria-hidden="true"
            onError={() => setImgFailed(true)}
          />
        </>
      )}
    </div>
  );
}
