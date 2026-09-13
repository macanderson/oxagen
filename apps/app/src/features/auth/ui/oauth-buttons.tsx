"use client";
// Social sign-in through Better Auth. The destination is the sanitised `next`,
// which Better Auth also checks against its trusted origins. Hidden in fixture
// mode: there is no provider to round-trip through.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";

type Provider = "google" | "github";

function ProviderMark({ provider }: { provider: Provider }) {
  // Provider marks are brand glyphs, not interface icons; drawn in currentColor so they stay on house tokens.
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
      viewBox="0 0 24 24"
      className="size-4 flex-none"
      fill="currentColor"
    >
      <path d="M12 11v3.1h7c-.3 1.9-2.2 5.6-7 5.6-4.2 0-7.6-3.5-7.6-7.7S7.8 4.3 12 4.3c2.4 0 4 .9 5 1.8L19.5 4C17.9 2.5 15.3 1.5 12 1.5 6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5c6.9 0 11.5-4.9 11.5-11.8 0-.8-.1-1.4-.2-2H12Z" />
    </svg>
  );
}

export function OAuthButtons({ callbackURL }: { callbackURL: string }) {
  const t = useTranslations("auth.sso");
  const [pending, setPending] = useState<Provider | null>(null);

  async function start(provider: Provider) {
    setPending(provider);
    try {
      const { authClient } = await import("@oxagen/auth/client");
      await authClient.signIn.social({ provider, callbackURL });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {(["google", "github"] as const).map((provider) => (
        <button
          key={provider}
          type="button"
          aria-disabled={pending !== null || undefined}
          onClick={() => {
            if (pending === null) void start(provider);
          }}
          className={`${buttonSecondary} justify-start`}
        >
          <ProviderMark provider={provider} />
          <span>{t(provider)}</span>
        </button>
      ))}
      <div
        className="flex items-center gap-3 text-xs uppercase tracking-[0.1em] text-muted-foreground"
        aria-hidden
      >
        <span className="h-px flex-1 bg-border" />
        {t("or")}
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
