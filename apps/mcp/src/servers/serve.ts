// serve.ts: the served tools middleware as production binds it (lane M15;
// mcp-studio-spec, Call path).
//
// The request's key resolves through the same buildContext every Oxagen tool
// uses. The run, the published version, and the ports read Postgres.
import type { ProposingAgentResolver } from "@oxagen/handlers/steering.proposer";
import { buildContext } from "../context";
import { createServedToolsMiddleware } from "./middleware";
import { createServedPorts, postgresPublishedSources, postgresRunSources, servedLog } from "./ports";
import { proposingAgentOf } from "./proposer";
import { loadPublished } from "./published";
import { resolveServedRun } from "./run";
import { ServedCache } from "./snapshot";

export const servedToolsMiddleware = createServedToolsMiddleware({
  context: (headers) => buildContext(headers),
  run: (ctx) => resolveServedRun(ctx, postgresRunSources),
  published: (scope) => loadPublished(postgresPublishedSources, scope),
  ports: createServedPorts,
  cache: new ServedCache(),
  log: servedLog,
});

/**
 * The agent behind a propose_steering call, from the same run and published
 * agents the served tools read (proposer.ts). middleware.ts registers it.
 */
export const servedProposingAgent: ProposingAgentResolver = (ctx) =>
  proposingAgentOf(ctx, { run: postgresRunSources, published: postgresPublishedSources });
