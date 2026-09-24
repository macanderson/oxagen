"use client";
// Social sign-in through Better Auth. The destination is the sanitised `next`,
// which Better Auth also checks against its trusted origins. Failures that
// never leave the page (provider unset, network) show as a form alert; failures
// after the provider round-trip land on /login?error= via errorCallbackURL.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import type { AuthOutcomeKey } from "../auth-errors";
import {
  liveSignInSocial,
  rememberSignedIn,
  takeSignedIn,
} from "../auth-client";
import { AuthAlert, AuthOr } from "./auth-card";

type Provider = "google" | "github";

function ProviderMark({ provider }: { provider: Provider }) {
  // Provider marks are brand glyphs, not interface icons. GitHub's is one
  // colour, drawn in currentColor so it follows the theme. Google's four-colour
  // G is drawn in its own colours, as the design and Google's brand rules draw it.
  if (provider === "github") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-4 flex-none"
        fill="currentColor"
      >
        <path d="M8 .4a7.6 7.6 0 0 0-2.4 14.8c.38.07.52-.16.52-.36v-1.3c-2.1.46-2.55-1-2.55-1-.35-.88-.85-1.12-.85-1.12-.7-.47.05-.46.05-.46.77.06 1.17.79 1.17.79.68 1.17 1.79.83 2.23.64.07-.5.27-.83.48-1.03-1.68-.19-3.45-.84-3.6-3.73 0-.82.3-1.5.77-2.02-.08-.19-.33-.96.07-2 0 0 .63-.2 2.07.77a7.1 7.1 0 0 1 3.77 0c1.44-.97 2.07-.77 2.07-.77.4 1.04.15 1.81.07 2 .48.52.77 1.2.77 2.02 0 2.9-1.77 3.53-3.46 3.72.28.24.52.7.52 1.42v2.1c0 .2.14.44.52.36A7.6 7.6 0 0 0 8 .4z" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      data-mark="google"
      viewBox="0 0 18 18"
      className="size-4 flex-none"
    >
      <path
        fill="#4285F4"
        d="M17.6 9.2c0-.6-.05-1.2-.16-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8z"
      />
      <path
        fill="#EA4335"
        d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"
      />
    </svg>
  );
}

/**
 * Continue with Google and Continue with GitHub, then the "or" rule (mockups
 * `obSso`). `announceSignIn` is set on Log in, where a provider that succeeds
 * lands on a signed-in page that shows "Signed in as …" once; Sign up lands
 * on onboarding and sets nothing.
 */
export function OAuthButtons({
  callbackURL,
  announceSignIn = false,
}: {
  callbackURL: SafePath;
  announceSignIn?: boolean;
}) {
  const t = useTranslations("auth");
  const tSso = useTranslations("auth.sso");
  const [pending, setPending] = useState<Provider | null>(null);
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);

  async function start(provider: Provider) {
    setPending(provider);
    setOutcome(null);
    // Marked before the browser leaves for the provider, and dropped when
    // the start fails here; a failure after the round-trip lands on /login,
    // which drops it too.
    if (announceSignIn) rememberSignedIn();
    try {
      const result = await liveSignInSocial({ provider, callbackURL });
      if (!result.ok) {
        if (announceSignIn) takeSignedIn();
        setOutcome(result.outcome);
      }
    } catch {
      if (announceSignIn) takeSignedIn();
      setOutcome("unavailable");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {outcome ? (
        <AuthAlert testId="oauth-outcome" message={t(`outcomes.${outcome}`)} />
      ) : null}
      <div className="grid gap-[9px]">
        {(["google", "github"] as const).map((provider) => (
          <button
            key={provider}
            type="button"
            aria-disabled={pending !== null || undefined}
            onClick={() => {
              if (pending === null) void start(provider);
            }}
            data-touch-target=""
            className={`${buttonSecondary} w-full justify-start`}
          >
            <ProviderMark provider={provider} />
            <span>{tSso(provider)}</span>
          </button>
        ))}
      </div>
      <AuthOr label={tSso("or")} />
    </div>
  );
}
