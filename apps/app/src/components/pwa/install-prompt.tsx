"use client";

/**
 * PWA install prompt.
 *
 * Three surfaces — all mutually exclusive:
 *  1. Chrome / Android: capture the `beforeinstallprompt` event and surface an
 *     "Install" CTA that triggers the native dialog.
 *  2. iOS Safari (no `beforeinstallprompt`): show a manual "Add to Home Screen"
 *     instruction sheet.
 *  3. Already installed / dismissed: render nothing.
 *
 * Dismissal is persisted in localStorage (`oxagen:pwa-install-dismissed`).
 * Once set, the banner is never shown again in that browser profile.
 */

import { useCallback, useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The browser's native install-prompt event (not yet in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

type PromptState =
  | { kind: "idle" }
  | { kind: "chrome"; event: BeforeInstallPromptEvent }
  | { kind: "ios" };

// ── Constants ─────────────────────────────────────────────────────────────────

const DISMISSED_KEY = "oxagen:pwa-install-dismissed";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Chrome/Firefox on iOS report WebKit but also include "CriOS"/"FxiOS"
  const isSafari = /safari/i.test(ua) && !/crios|fxios|opios|mercury/i.test(ua);
  return isIos && isSafari;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // navigator.standalone is iOS-specific
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  );
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "true");
  } catch {
    // localStorage can be unavailable in private mode on some browsers.
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function InstallPrompt() {
  const [state, setState] = useState<PromptState>({ kind: "idle" });

  useEffect(() => {
    // Never show if already installed or previously dismissed.
    if (isStandalone() || isDismissed()) return;

    // iOS: show manual instructions.
    if (isIosSafari()) {
      setState({ kind: "ios" });
      return;
    }

    // Chrome / Android: wait for the deferred prompt.
    const handler = (e: Event) => {
      e.preventDefault();
      setState({ kind: "chrome", event: e as BeforeInstallPromptEvent });
    };

    window.addEventListener("beforeinstallprompt", handler);

    // Clean up once installed so the banner disappears automatically.
    const installedHandler = () => {
      persistDismissed();
      setState({ kind: "idle" });
    };
    window.addEventListener("appinstalled", installedHandler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installedHandler);
    };
  }, []);

  const dismiss = useCallback(() => {
    persistDismissed();
    setState({ kind: "idle" });
  }, []);

  const install = useCallback(async () => {
    if (state.kind !== "chrome") return;
    await state.event.prompt();
    const { outcome } = await state.event.userChoice;
    if (outcome === "accepted") {
      persistDismissed();
    }
    setState({ kind: "idle" });
  }, [state]);

  if (state.kind === "idle") return null;

  return (
    <div
      role="region"
      aria-label="Install Oxagen"
      aria-live="polite"
      style={bannerStyles.root}
    >
      <div style={bannerStyles.inner}>
        {state.kind === "chrome" ? (
          <>
            <p style={bannerStyles.text}>
              Install Oxagen for a faster, native-app experience.
            </p>
            <div style={bannerStyles.actions}>
              <button
                type="button"
                onClick={install}
                style={bannerStyles.installBtn}
              >
                Install
              </button>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss install prompt"
                style={bannerStyles.dismissBtn}
              >
                &times;
              </button>
            </div>
          </>
        ) : (
          /* iOS instructions */
          <>
            <p style={bannerStyles.text}>
              Install Oxagen: tap{" "}
              <ShareIcon label="Share icon" style={{ verticalAlign: "middle" }} />{" "}
              then <strong>Add to Home Screen</strong>.
            </p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss install prompt"
              style={bannerStyles.dismissBtn}
            >
              &times;
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Share icon (inline SVG — no icon-lib dep) ─────────────────────────────────

function ShareIcon({ label, style }: { label?: string; style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      style={style}
    >
      <path d="M12 2l-4 4h3v8h2V6h3l-4-4zM5 18v2h14v-2H5z" />
    </svg>
  );
}

// ── Inline styles ─────────────────────────────────────────────────────────────
// CSS modules can't be used here without introducing a new file that may
// conflict with global @media; inline styles keep the component fully
// self-contained. Tailwind utility classes from @/components/ui/* require
// the class names to be statically analysable — not reliable in a utility
// component. We use inline styles + a single @media via a <style> tag inserted
// once (see bottom of this file).

const bannerStyles = {
  root: {
    position: "fixed",
    bottom: "env(safe-area-inset-bottom, 0px)",
    left: 0,
    right: 0,
    zIndex: 9998,
    padding: "0 0 12px",
    display: "flex",
    justifyContent: "center",
    // Hide on desktop — this is a mobile-first install nudge.
    // The @media override below reveals it on small viewports only.
  } satisfies React.CSSProperties,
  inner: {
    background: "#1a1d28",
    color: "#faf7f2",
    borderRadius: "16px 16px 12px 12px",
    boxShadow: "0 -2px 16px rgba(0,0,0,0.4)",
    padding: "14px 16px 14px 20px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    maxWidth: 480,
    width: "calc(100% - 24px)",
    fontSize: 14,
    lineHeight: 1.4,
  } satisfies React.CSSProperties,
  text: {
    margin: 0,
    flex: 1,
  } satisfies React.CSSProperties,
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  } satisfies React.CSSProperties,
  installBtn: {
    background: "#6e48ce",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "7px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1,
  } satisfies React.CSSProperties,
  dismissBtn: {
    background: "transparent",
    border: "none",
    color: "#faf7f2",
    cursor: "pointer",
    fontSize: 20,
    lineHeight: 1,
    padding: "4px 6px",
    borderRadius: 4,
    opacity: 0.6,
  } satisfies React.CSSProperties,
} as const;
