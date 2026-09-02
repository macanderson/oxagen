"use client";
/**
 * connected-accounts.tsx — Connected accounts section for the profile page.
 *
 * Shows Google and GitHub linked/unlinked state with connect/disconnect actions.
 * Enforces the last-method guard: when signInMethodCount === 1, the only
 * remaining method's Disconnect button is disabled.
 */
import * as React from "react";
import { Github } from "lucide-react";
import { useRouter } from "next/navigation";
import { authClient } from "@oxagen/auth/client";
import { Button } from "@/components/ui/button";
import { unlinkAccountAction } from "./security-action";
import type { ConnectedAccountsState, LinkedAccount } from "./security-types";

interface ConnectedAccountsProps {
  state: ConnectedAccountsState;
}

type ProviderKey = "google" | "github";

const PROVIDERS: { key: ProviderKey; label: string; icon: React.ReactNode }[] =
  [
    {
      key: "google",
      label: "Google",
      icon: <GoogleIcon />,
    },
    {
      key: "github",
      label: "GitHub",
      icon: <Github className="h-4 w-4" aria-hidden />,
    },
  ];

export function ConnectedAccounts({ state }: ConnectedAccountsProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<ProviderKey | null>(null);
  const [errors, setErrors] = React.useState<
    Partial<Record<ProviderKey, string>>
  >({});

  const accountsByProvider = React.useMemo(() => {
    const map: Partial<Record<ProviderKey, LinkedAccount>> = {};
    for (const acc of state.accounts) {
      if (acc.providerId === "google" || acc.providerId === "github") {
        map[acc.providerId] = acc;
      }
    }
    return map;
  }, [state.accounts]);

  const handleConnect = (provider: ProviderKey) => {
    setPending(provider);
    setErrors((prev) => ({ ...prev, [provider]: undefined }));
    // linkSocial redirects; pending state is cleared naturally on return.
    authClient
      .linkSocial({ provider, callbackURL: "/account/profile" })
      .catch(() => {
        setPending(null);
      });
  };

  const handleDisconnect = async (provider: ProviderKey) => {
    setPending(provider);
    setErrors((prev) => ({ ...prev, [provider]: undefined }));

    const result = await unlinkAccountAction({ providerId: provider });

    if (result.ok) {
      // Refresh so the server re-derives state (hasPassword, signInMethodCount).
      router.refresh();
    } else {
      setErrors((prev) => ({ ...prev, [provider]: result.error }));
    }
    setPending(null);
  };

  return (
    <section aria-label="Connected accounts" className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Connected accounts</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Sign in with any of your connected accounts.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map(({ key, label, icon }) => {
          const linked = accountsByProvider[key];
          const isLastMethod = state.signInMethodCount <= 1 && Boolean(linked);
          const isBusy = pending === key;

          return (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-foreground">{icon}</span>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{label}</span>
                  {linked ? (
                    <span className="text-xs text-muted-foreground">
                      Connected
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not connected
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end gap-1">
                {linked ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isBusy || isLastMethod}
                    onClick={() => {
                      void handleDisconnect(key);
                    }}
                    aria-label={`Disconnect ${label}`}
                  >
                    {isBusy ? "Disconnecting…" : "Disconnect"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onClick={() => handleConnect(key)}
                    aria-label={`Connect ${label}`}
                  >
                    {isBusy ? "Connecting…" : "Connect"}
                  </Button>
                )}

                {/* Last-method safety note */}
                {isLastMethod && (
                  <p className="text-xs text-muted-foreground max-w-[200px] text-right">
                    Set a password or connect another account before
                    disconnecting.
                  </p>
                )}

                {/* Inline error */}
                {errors[key] && (
                  <p className="text-xs text-destructive" role="alert">
                    {errors[key]}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M12 11v3.1h7c-.3 1.9-2.2 5.6-7 5.6-4.2 0-7.6-3.5-7.6-7.7S7.8 4.3 12 4.3c2.4 0 4 .9 5 1.8L19.5 4C17.9 2.5 15.3 1.5 12 1.5 6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5c6.9 0 11.5-4.9 11.5-11.8 0-.8-.1-1.4-.2-2H12Z"
      />
    </svg>
  );
}
