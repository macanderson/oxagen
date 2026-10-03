"use client";
// A provider's status light and its Reconnect (#4132).
//
// The light is green, yellow or red (`providerLight` in view.ts), and always
// carries a word, so the state never rides on colour alone. Reconnect re-runs
// the OAuth sign-in for the provider in a popup; it is offered for an OAuth
// provider to the roles that may authorize one, and is the primary fix
// whenever the light is red for an authorization reason.
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { McpServer } from "@/data/contracts/tools";
import { Button } from "@/ui/button";
import { FormAlert } from "@/ui/form-feedback";
import { ProviderLink, useNavigate } from "@/ui/navigation";
import { useOAuthFailureText } from "./oauth-failure";
import { StateDot } from "./parts";
import { useProviderOAuth } from "./use-provider-oauth";
import {
  needsReconnect,
  type ProviderLight,
  providerLight,
  type ToolsAt,
} from "./view";

const LIGHT_TONE: Record<ProviderLight, "ok" | "warn" | "deny"> = {
  green: "ok",
  yellow: "warn",
  red: "deny",
};

/** The light and its word, with the reason as a title for the curious. */
export function ProviderStatusLight({ server }: { server: McpServer }) {
  const t = useTranslations("tools.providers.status");
  const now = useNow({ updateInterval: 60_000 });
  const { light, reason } = providerLight(server, now.getTime());
  return (
    <span
      data-testid={`provider-status-${server.id}`}
      data-light={light}
      data-reason={reason}
      title={t(`reasons.${reason}`)}
      className="inline-flex flex-col gap-0.5"
    >
      <StateDot
        tone={LIGHT_TONE[light]}
        name={light}
        label={t(`lights.${light}`)}
      />
      <span className="text-xs text-muted-foreground">
        {t(`short.${reason}`)}
      </span>
    </span>
  );
}

/** How the provider authenticates, and for OAuth when its token lapses. */
export function ProviderAuthorization({ server }: { server: McpServer }) {
  const t = useTranslations("tools.providers.status");
  const format = useFormatter();
  const auth = server.authorization;
  if (auth === null) {
    return (
      <span className="text-sm text-foreground">
        {t(`kinds.${server.authKind}`)}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 text-sm">
      <span className="text-foreground">{t(`states.${auth.state}`)}</span>
      {auth.expiresAt === null ? null : (
        <span className="text-xs text-muted-foreground">
          {t("expires", {
            when: format.dateTime(new Date(auth.expiresAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {auth.refreshable ? t("refreshable") : t("notRefreshable")}
      </span>
    </span>
  );
}

/** Re-run the OAuth sign-in for one provider, in a popup, from where it is shown. */
export function ReconnectProvider({
  at,
  server,
}: {
  at: ToolsAt;
  server: McpServer;
}) {
  const t = useTranslations("tools.providers.reconnect");
  const tOAuth = useTranslations("tools.import.oauth");
  const failureText = useOAuthFailureText();
  const navigate = useNavigate();
  const now = useNow({ updateInterval: 60_000 });
  const oauth = useProviderOAuth(at, () => {
    navigate.refresh();
  });
  if (server.authKind !== "oauth") return null;
  const urgent = needsReconnect(providerLight(server, now.getTime()).reason);
  const phase = oauth.phase;
  return (
    <span className="flex flex-col gap-1.5">
      <Button
        type="button"
        data-testid={`provider-reconnect-${server.id}`}
        aria-disabled={
          phase.kind === "starting" || phase.kind === "waiting" || undefined
        }
        aria-label={t("named", { name: server.name })}
        variant={urgent ? "primary" : "outline"}
        onClick={() => {
          if (phase.kind === "starting" || phase.kind === "waiting") return;
          void oauth.start({ mode: "reconnect", serverId: server.id });
        }}
      >
        {phase.kind === "starting" ? t("pending") : t("open")}
      </Button>
      {phase.kind === "waiting" ? (
        <span
          role="status"
          className="flex flex-col gap-1 text-sm text-muted-foreground"
        >
          {phase.blockedUrl === null
            ? tOAuth("waiting", { name: server.name })
            : tOAuth("blocked", { name: server.name })}
          {phase.blockedUrl === null ? null : (
            <ProviderLink
              to={phase.blockedUrl}
              className="text-app-link-fg underline-offset-2 hover:underline"
            >
              {tOAuth("openSignIn")}
            </ProviderLink>
          )}
          {/* A closed popup posts nothing back, so waiting ends here, not on a reload. */}
          <Button
            type="button"
            data-testid={`provider-reconnect-cancel-${server.id}`}
            variant="outline" className="self-start"
            onClick={oauth.reset}
          >
            {tOAuth("cancel")}
          </Button>
        </span>
      ) : null}
      {phase.kind === "failed" ? (
        <FormAlert testId={`provider-reconnect-failure-${server.id}`}>
          {failureText(phase.failure)}
        </FormAlert>
      ) : null}
      {phase.kind === "client_required" ? (
        <FormAlert testId={`provider-reconnect-failure-${server.id}`}>
          {t("clientRequired")}
        </FormAlert>
      ) : null}
    </span>
  );
}

/**
 * The warning under the Providers table: how many providers are red or
 * yellow, named by what is wrong. Nothing is printed when all are green.
 */
export function ProvidersAttention({
  servers,
}: {
  servers: readonly McpServer[];
}) {
  const t = useTranslations("tools.providers.status");
  const now = useNow({ updateInterval: 60_000 });
  const lights = servers.map((server) => providerLight(server, now.getTime()));
  const red = lights.filter((l) => l.light === "red").length;
  const yellow = lights.filter((l) => l.light === "yellow").length;
  if (red === 0 && yellow === 0) return null;
  return (
    <p
      role="status"
      data-testid="tools-providers-attention"
      className="max-w-prose rounded-lg border border-border px-3 py-2.5 text-sm text-foreground"
    >
      {t("attention", { red, yellow })}
    </p>
  );
}
