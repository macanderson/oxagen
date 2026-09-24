// The agent source page (spec pages/agent-source.md; ARCHITECTURE.md §1.2
// Agents row): `.oxagen/agents/<slug>.toml` in a source editor. The file is
// the text the last `commit_agent_definition` cached, or, for an agent with no
// committed file, a seed of the three keys the commit handler requires of
// every file, written from its identity. The spec reads it from the bound
// repository; the app has no read of the repository file yet, so the chips
// name the commit the cache holds and nothing stronger.
//
// Its loading, error and denied states replace the page body, never the
// shell (`page-states.tsx`).
import { AGENT_DEFINITION_DIR } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { notFound } from "next/navigation";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { repositoryOf } from "./definition-repo";
import { definitionSeed } from "./definition-seed";
import { AgentPageFailure } from "./page-states";
import { SourceEditor } from "./source-editor";

/** The identity and the instant its read returned, so a failure can name when it failed. */
async function readDetail(ctx: WsCtx, source: DataSource, agent: string) {
  const read = await source.agents.get(ctx, agent);
  return { read, at: new Date().toISOString() };
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
  const { read, at } = await readDetail(ctx, source, agent);
  const org = ctx.orgSlug;
  const ws = ctx.wsSlug;
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <AgentPageFailure
        read={read}
        subject="source"
        viewer={ctx}
        retry={routes.agentSource(org, ws, agent)}
        readAt={at}
      />
    );
  }
  const { identity, definition } = read.value;
  const path =
    definition?.path ?? `${AGENT_DEFINITION_DIR}/${identity.slug}.toml`;
  return (
    <SourceEditor
      org={org}
      ws={ws}
      agentId={identity.id}
      agentKey={identity.agentKey}
      slug={identity.slug}
      path={path}
      base={definition?.source ?? definitionSeed(identity)}
      branch={definition?.branch ?? `agents/${identity.slug}`}
      commit={definition?.commitSha ?? null}
      repository={
        definition === null ? null : repositoryOf(definition.pullRequestUrl)
      }
      back={routes.agent(org, ws, identity.slug, { tab: "definition" })}
      after={routes.agentSource(org, ws, identity.slug)}
    />
  );
}
