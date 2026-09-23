"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { parseGitHubUrl } from "@/shared/github-url";
import { GitHubLink } from "@/ui/navigation";
import { panel, buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { loadRunIssueProviders, authorizeRunIssues } from "./provider-actions";

type ProviderRead = Awaited<ReturnType<typeof loadRunIssueProviders>>;
export function RunIssueConnections({
  at,
  runId,
  enabled,
  canManage,
}: {
  at: { org: string; ws: string };
  runId: string;
  enabled: boolean;
  canManage: boolean;
}) {
  const t = useTranslations("runOutcomes");
  const [read, setRead] = useState<ProviderRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true);
    setError(null);
    try {
      setRead(await loadRunIssueProviders(at));
    } catch {
      setError(t("providerFailed"));
    } finally {
      setLoading(false);
    }
  }
  async function authorize() {
    setAuthorizing(true);
    setError(null);
    try {
      const result = await authorizeRunIssues(at, runId);
      if (!result.ok) setError(t("authorizationFailed"));
    } catch {
      setError(t("authorizationFailed"));
    } finally {
      setAuthorizing(false);
    }
  }
  const data = read?.ok ? read.value : null;
  const connect = parseGitHubUrl(data?.github.connectUrl ?? null);
  const install = parseGitHubUrl(data?.github.installUrl ?? null);
  return (
    <section
      aria-label={t("providersTitle")}
      className={`${panel} space-y-3 p-4`}
    >
      <h2 className="text-sm font-semibold">{t("providersTitle")}</h2>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">{t("providerOwner")}</p>
      ) : (
        <>
          <button
            type="button"
            className={buttonSecondary}
            disabled={loading}
            onClick={() => {
              void load();
            }}
          >
            {loading ? t("loadingProviders") : t("loadProviders")}
          </button>
          {!enabled ? (
            <p className="text-sm text-muted-foreground">
              {t("providerConsent")}
            </p>
          ) : null}
          {read && !read.ok ? (
            <FormAlert>{t("providerFailed")}</FormAlert>
          ) : null}
          {data ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">GitHub</h3>
                {data.github.connected ? (
                  <p className="text-sm text-muted-foreground">
                    {t("githubConnected")}
                  </p>
                ) : null}
                {!connect && !install ? (
                  <p className="text-sm text-muted-foreground">
                    {t("githubUnconfigured")}
                  </p>
                ) : enabled ? (
                  <div className="flex flex-wrap gap-2">
                    {connect ? (
                      <GitHubLink to={connect} className={buttonSecondary}>
                        {t("githubConnect")}
                      </GitHubLink>
                    ) : null}
                    {install ? (
                      <GitHubLink to={install} className={buttonSecondary}>
                        {t("githubInstall")}
                      </GitHubLink>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Linear</h3>
                {data.linear.connections.length ? (
                  data.linear.connections.map((connection) => (
                    <p
                      className="text-sm text-muted-foreground"
                      key={connection.connectionId}
                    >
                      {t("linearConnected", { name: connection.name })}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("linearEmpty")}
                  </p>
                )}
                {data.linear.configured ? (
                  <button
                    type="button"
                    className={buttonSecondary}
                    disabled={!enabled || authorizing}
                    onClick={() => {
                      void authorize();
                    }}
                  >
                    {authorizing ? t("linearConnecting") : t("linearConnect")}
                  </button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("linearUnconfigured")}
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </section>
  );
}
