"use client";
// Browse the MCP Registry from the Add a provider wizard (#4132): verified
// first-party servers first, then the official registry's matches, each with
// what a person needs before choosing it. That is the icon, name and publisher,
// whether the publisher proved it owns the name, the transports, how it
// authenticates, and where its site and docs are.
//
// A server Oxagen cannot reach (an `sse` remote, a `stdio` package that runs on
// the agent's machine) is listed with the reason and no Select, so a search
// never hides that a server exists.
import { useTranslations } from "next-intl";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RegistryServer } from "@/data/contracts/tools";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { parseProviderUrl } from "@/shared/provider-url";
import { FormAlert } from "@/ui/form-feedback";
import { ProviderLink } from "@/ui/navigation";
import { ProviderIcon } from "@/ui/provider-icon";
import { useActionFailure } from "./action-failure";
import { searchRegistry } from "./provider-auth-actions";
import type { ToolsAt } from "./view";

const TESTID = "registry-browser";
/** Wait this long after the last keystroke before searching. */
const DEBOUNCE_MS = 300;

type Results = {
  servers: readonly RegistryServer[];
  nextCursor: string | null;
  registryReachable: boolean;
};

function AuthChip({ server }: { server: RegistryServer }) {
  const t = useTranslations("tools.import.browse.auth");
  const label =
    server.auth === "oauth" && server.oauthRegistration === "client_required"
      ? t("oauthClient")
      : t(server.auth);
  return (
    <span
      data-auth={server.auth}
      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground"
    >
      {label}
    </span>
  );
}

function ResultCard({
  server,
  onPick,
}: {
  server: RegistryServer;
  onPick: (server: RegistryServer) => void;
}) {
  const t = useTranslations("tools.import.browse");
  // Each link once: the docs are often the website, the source the docs.
  const seen = new Set<string>();
  const links = (
    [
      ["website", server.websiteUrl],
      ["docs", server.docsUrl],
      ["source", server.repositoryUrl],
    ] as const
  ).flatMap(([key, raw]) => {
    const to = parseProviderUrl(raw);
    if (to === null || seen.has(to)) return [];
    seen.add(to);
    return [{ key, to }];
  });
  const unreachable = server.transports.includes("stdio")
    ? t("stdioOnly")
    : t("noRemote");
  return (
    <li
      data-registry-server={server.registryRef}
      className="flex min-w-0 gap-3 rounded-lg border border-border px-3 py-2.5"
    >
      <ProviderIcon name={server.name} iconUrl={server.iconUrl} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-foreground">{server.name}</span>
          <span className="text-xs text-muted-foreground">
            {server.publisherVerified
              ? t("publisherVerified", { publisher: server.publisher })
              : t("publisher", { publisher: server.publisher })}
          </span>
          {server.source === "verified" ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-foreground">
              {t("verified")}
            </span>
          ) : null}
        </div>
        {server.description === "" ? null : (
          <p className="line-clamp-2 text-[13px] text-muted-foreground">
            {server.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {server.transports.map((transport) => (
            <span
              key={transport}
              className={`${mono} rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground`}
            >
              {transport}
            </span>
          ))}
          <AuthChip server={server} />
          {server.version === null ? null : (
            <span className={`${mono} text-[11px] text-muted-foreground`}>
              {t("version", { version: server.version })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {links.map(({ key, to }) => (
            <ProviderLink
              key={key}
              to={to}
              className="text-app-link-fg underline-offset-2 hover:underline"
            >
              {t(key)}
            </ProviderLink>
          ))}
        </div>
        {server.connectable ? null : (
          <p className="text-xs text-muted-foreground">{unreachable}</p>
        )}
      </div>
      {server.connectable ? (
        <button
          type="button"
          data-testid={`${TESTID}-pick-${server.registryRef}`}
          aria-label={t("pickNamed", { name: server.name })}
          className={`${buttonSecondary} self-center`}
          onClick={() => {
            onPick(server);
          }}
        >
          {t("pick")}
        </button>
      ) : null}
    </li>
  );
}

export function RegistryBrowser({
  at,
  onPick,
}: {
  at: ToolsAt;
  onPick: (server: RegistryServer) => void;
}) {
  const t = useTranslations("tools.import.browse");
  const failureText = useActionFailure();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Answers can land out of order; only the latest search's answer is kept.
  const latestRef = useRef(0);

  async function run(q: string, cursor?: string) {
    const ticket = ++latestRef.current;
    setLoading(true);
    setFailure(null);
    try {
      const result = await searchRegistry(at.org, at.ws, {
        query: q,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (ticket !== latestRef.current) return;
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      setResults((before) =>
        cursor === undefined || before === null
          ? result.value
          : {
              ...result.value,
              servers: [...before.servers, ...result.value.servers],
            },
      );
    } catch {
      if (ticket === latestRef.current) {
        setFailure(
          failureText({
            ok: false,
            reason: "unavailable",
            code: "action_failed",
          }),
        );
      }
    } finally {
      if (ticket === latestRef.current) setLoading(false);
    }
  }

  // Only the query starts a search; `run` reads the latest `at` when it fires.
  const search = useEffectEvent((q: string) => {
    void run(q);
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      search(query);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div data-testid={TESTID} className="flex flex-col gap-2.5">
      <label
        htmlFor={`${TESTID}-query`}
        className="text-sm font-medium text-foreground"
      >
        {t("search")}
      </label>
      <input
        id={`${TESTID}-query`}
        type="search"
        value={query}
        autoComplete="off"
        placeholder={t("searchPlaceholder")}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        className={inputBase}
      />
      <p className="text-xs text-muted-foreground">{t("sourceNote")}</p>
      {failure === null ? null : (
        <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
      )}
      {results?.registryReachable === false ? (
        <p
          data-testid={`${TESTID}-unreachable`}
          className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {t("registryUnreachable")}
        </p>
      ) : null}
      {results === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("searching")}
        </p>
      ) : results.servers.length === 0 && !loading ? (
        <p data-state="empty" className="text-sm text-muted-foreground">
          {t("empty", { query: query.trim() })}
        </p>
      ) : (
        <ul
          aria-label={t("results")}
          aria-busy={loading || undefined}
          className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto pr-1"
        >
          {results.servers.map((server) => (
            <ResultCard
              key={server.registryRef}
              server={server}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
      {results?.nextCursor ? (
        <button
          type="button"
          data-testid={`${TESTID}-more`}
          aria-disabled={loading || undefined}
          className={`${buttonSecondary} self-start`}
          onClick={() => {
            if (!loading && results.nextCursor !== null) {
              void run(query, results.nextCursor);
            }
          }}
        >
          {loading ? t("searching") : t("more")}
        </button>
      ) : null}
    </div>
  );
}
