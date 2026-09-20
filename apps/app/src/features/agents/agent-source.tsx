// The agent definition source page (ARCHITECTURE.md §1.2 Agents row; mockup
// `pAgentSource`, Mockups bcc7049): `.oxagen/agents/<slug>.toml` as the last
// commit_agent_definition cached it, in the source editor. An agent with no
// committed file starts from a seed of the three keys the commit handler
// requires of every file, written from its identity. Its loading, error and
// denied states replace the editor, never the page.
import { AGENT_DEFINITION_DIR } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { mono, panel } from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { definitionSeed } from "./definition-seed";
import { SourceEditor } from "./source-editor";

function Chips({ detail, path }: { detail: AgentDetail; path: string }) {
  const t = useTranslations("agents");
  const chip = `${mono} rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs`;
  const { definition, identity } = detail;
  return (
    <ul aria-label={t("source.facts")} className="flex flex-wrap gap-2">
      <li className={chip}>{path}</li>
      <li className={chip}>
        {definition === null
          ? t("source.uncommitted")
          : t("source.branchAt", {
              branch: definition.branch,
              commit: definition.commitSha,
            })}
      </li>
      <li className={chip}>{t("source.truth")}</li>
      {identity.agentKey === null ? null : (
        <li className={chip}>{identity.agentKey}</li>
      )}
    </ul>
  );
}

export function AgentSourceLoading() {
  const t = useTranslations("agents.source");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="source-loading"
      className={`${panel} flex flex-col gap-2 p-4`}
    >
      <span className="sr-only">{t("loading")}</span>
      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
        <span
          key={row}
          aria-hidden="true"
          className="h-4 w-full animate-pulse rounded bg-muted motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

export async function AgentSource({
  ctx,
  source,
  agent,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The agent's slug or public id, as the URL names it. */
  agent: string;
}) {
  const read = await source.agents.get(ctx, agent);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <div className={`${panel} p-4`}>
        <ReadFailure read={read} section={agent} />
      </div>
    );
  }
  const { identity, definition } = read.value;
  const path =
    definition?.path ?? `${AGENT_DEFINITION_DIR}/${identity.slug}.toml`;
  const org = ctx.orgSlug;
  const ws = ctx.wsSlug;
  return (
    <SourcePage
      detail={read.value}
      path={path}
      editor={
        <SourceEditor
          org={org}
          ws={ws}
          agentId={identity.id}
          slug={identity.slug}
          path={path}
          base={definition?.source ?? definitionSeed(identity)}
          branch={definition?.branch ?? `agents/${identity.slug}`}
          back={routes.agent(org, ws, identity.slug, { tab: "definition" })}
          after={routes.agentSource(org, ws, identity.slug)}
        />
      }
    />
  );
}

function SourcePage({
  detail,
  path,
  editor,
}: {
  detail: AgentDetail;
  path: string;
  editor: React.ReactNode;
}) {
  const t = useTranslations("agents.source");
  return (
    <div className="flex flex-col gap-4">
      <Chips detail={detail} path={path} />
      <p className="max-w-prose text-sm text-muted-foreground">{t("lead")}</p>
      {editor}
    </div>
  );
}
