// serve.ts: the served tools middleware as production binds it (lane M15;
// mcp-studio-spec, Call path).
//
// The request's key resolves through the same buildContext every Oxagen tool
// uses. The run, the published version, and the ports read Postgres.
import { buildContext } from "../context";
import { createServedToolsMiddleware } from "./middleware";
import { createServedPorts, postgresPublishedSources, postgresRunSources, servedLog } from "./ports";
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
