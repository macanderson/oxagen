"use client";

/**
 * PWA install prompt.
 *
 * Mobile-only: this nudge only ever mounts on phones/tablets (`isMobileDevice`).
 * Desktop browsers also fire `beforeinstallprompt`, but the install affordance
 * there belongs in the browser's omnibox, not in a banner — so desktop is
 * suppressed entirely.
 *
 * Three surfaces — all mutually exclusive:
 *  1. Chrome / Android: capture the `beforeinstallprompt` event and surface an
 *     "Install" CTA that triggers the native dialog.
 *  2. iOS Safari (no `beforeinstallprompt`): show a manual "Add to Home Screen"
 *     instruction sheet.
 *  3. Already installed / dismissed / desktop: render nothing.
 *
 * Dismissal is persisted in localStorage (`oxagen:pwa-install-dismissed`).
 * Once set, the banner is never shown again in that browser profile.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Route prefixes where the nudge must never render: pre-auth and onboarding
 * flows have tall bottom-anchored forms, and the banner was found covering
 * the "Sign in" / "Create account" / org-creation submit buttons on phones.
 * The nudge belongs inside the app, once the user is actually using it.
 */
const SUPPRESSED_ROUTE_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/two-factor",
  "/verify",
  "/new-organization",
  "/cli/authorize",
  "/github/setup",
];

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

/**
 * Whether this is a phone/tablet ("smart device"). This nudge is mobile-only:
 * desktop Chrome/Edge also fire `beforeinstallprompt`, so without this gate the
 * banner would (and did) surface on desktop, where it doesn't belong.
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  // Chromium exposes a first-class mobile hint — trust it when present.
  const uaData = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile;

  // Fallback: UA sniff for known phone/tablet platforms.
  const ua = navigator.userAgent;
  if (
    /android|iphone|ipad|ipod|iemobile|blackberry|opera mini|mobile/i.test(ua)
  ) {
    return true;
  }

  // iPadOS 13+ Safari masquerades as desktop macOS; touch points give it away.
  return /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
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
  // usePathname() is typed non-null in the app router but CAN be null outside
  // it (tests, pages-router mounts) — treat that as "no route, don't suppress".
  const pathname = usePathname() ?? "";
  const suppressed = SUPPRESSED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );

  useEffect(() => {
    // Never show if already installed or previously dismissed.
    if (isStandalone() || isDismissed()) return;

    // Mobile-only nudge — never surface on desktop, where the browser's own
    // omnibox install affordance already covers PWA installation.
    if (!isMobileDevice()) return;

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

  if (state.kind === "idle" || suppressed) return null;

  return (
    <div
      role="region"
      aria-label="Install Oxagen"
      aria-live="polite"
      data-pwa-install-prompt=""
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
              <ShareIcon
                label="Share icon"
                style={{ verticalAlign: "middle" }}
              />{" "}
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

function ShareIcon({
  label,
  style,
}: {
  label?: string;
  style?: React.CSSProperties;
}) {
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
// Inline styles keep the component fully self-contained. Tailwind utility
// classes from @/components/ui/* require statically analysable class names —
// not reliable in a utility component. Desktop suppression is handled in JS
// (see `isMobileDevice`), so no viewport @media is needed here: the banner only
// mounts on phones/tablets.

const bannerStyles = {
  root: {
    position: "fixed",
    // Sits at the safe-area edge by default; when the shell's mobile bottom
    // nav is mounted, globals.css raises `--pwa-toast-bottom` so the banner
    // clears the bar instead of covering its tabs.
    bottom: "var(--pwa-toast-bottom, env(safe-area-inset-bottom, 0px))",
    left: 0,
    right: 0,
    zIndex: 9998,
    padding: "0 0 12px",
    display: "flex",
    justifyContent: "center",
  } satisfies React.CSSProperties,
  inner: {
    background: "#262624",
    color: "#F4F1EA",
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
    background: "#EFC53F",
    color: "#0A0A0C",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1,
  } satisfies React.CSSProperties,
  // ≥44px hit area (Apple HIG touch minimum) — the glyph stays small; the
  // padding-box carries the target size.
  dismissBtn: {
    background: "transparent",
    border: "none",
    color: "#F4F1EA",
    cursor: "pointer",
    fontSize: 20,
    lineHeight: 1,
    minWidth: 44,
    minHeight: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    opacity: 0.6,
  } satisfies React.CSSProperties,
} as const;
