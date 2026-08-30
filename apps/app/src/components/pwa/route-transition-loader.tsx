"use client";

/**
 * Route-transition loading indicator for mobile.
 *
 * Uses `usePathname` to detect navigation: when the pathname changes we show
 * the spinner and hide it again after a short window. Visibility is gated to
 * small screens via a CSS media query so desktop users are unaffected.
 *
 * Respects `prefers-reduced-motion` — the stylesheet hides `.loader` entirely
 * when the user has opted out, so no animation ever runs.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./route-transition-loader.module.css";
import Image from "next/image";

export function RouteTransitionLoader() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [imgFailed, setImgFailed] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the previous pathname so we only trigger on *changes*, not the
  // initial mount render.
  const prevPathRef = useRef<string>(pathname);

  useEffect(() => {
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;

    // Show the spinner on navigation start.
    setVisible(true);

    // Auto-hide after a short window. In practice the page content appears
    // before this fires, but this is the safety net.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 600);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pathname]);

  if (!visible) return null;

  return (
    <div className={styles.loader} role="status" aria-label="Navigating">
      {imgFailed ? (
        <span className={styles.cssSpinner} aria-hidden="true" />
      ) : (
        <Image
          src="/spinner/oxagen-spinner-assemble.svg"
          alt=""
          width={72}
          height={72}
          className={styles.spinnerDark}
          aria-hidden="true"
          onError={() => setImgFailed(true)}
        />
      )}
    </div>
  );
}
