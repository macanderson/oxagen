// The Studio record (#4678, part 3): one server folder read through
// get_studio_server, mapped to what the server page draws.
//
// The page reads the registry row first, because the row names the folder
// (`steeringName`). A server no steering repo defines has no folder, so it
// has no record. A refused read has none either, and the page draws each
// value only the record holds as not recorded.
//
// Each tool comes from the capability's catalog: a tools.toml key, or a tool
// the last discovery found that no key imports, joined to the key's shaping
// and its agent feedback (ADR-234). A tool no key imports has no feedback,
// because agents cannot call it. When the call store did not answer, the
// counts are null and the panel draws the feedback as not recorded.
import type { ToolStudioServerGetOutput } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import type { McpServer } from "@/data/contracts/tools";
import type { WsCtx } from "@/server/viewer";
import { getStudioServerAction } from "./actions";
import type { StudioRecord } from "./model";
import type { RecordReader } from "./seams";

type ServerOutput = ToolStudioServerGetOutput;

/** The MCP hints a server set to true, such as `destructiveHint`. */
function hintsOf(annotations: Readonly<Record<string, unknown>> | null): string[] {
  return Object.entries(annotations ?? {})
    .filter(([, value]) => value === true)
    .map(([name]) => name);
}

/** One key's agent feedback, or null when the counts were not read. */
function feedbackOf(entry: ServerOutput["feedback"]["tools"][number] | undefined) {
  if (entry === undefined || entry.counts === null) return null;
  return { ...entry.counts, notes: entry.notes };
}

/** get_studio_server's output as the server page's record. */
function toStudioRecord(out: ServerOutput): StudioRecord {
  const shaping = new Map(out.shaping.map((entry) => [entry.tool, entry]));
  const feedback = new Map(out.feedback.tools.map((entry) => [entry.tool, entry]));
  return {
    folder: out.folder,
    // The contract's source shapes are the page's, key for key.
    source: out.source,
    auth: {
      mode: out.auth.mode,
      scheme: out.auth.scheme,
      credential: out.auth.credential,
    },
    environments: out.environments,
    exposure: {
      mode: out.exposure.mode,
      definitionBudget: out.exposure.budget,
    },
    sync: { schedule: out.sync.schedule, lastAt: out.sync.lastAt },
    tools: out.tools.map((tool) => {
      const shape = tool.key === null ? undefined : shaping.get(tool.key);
      return {
        name: tool.key ?? tool.name,
        imported: tool.state === "imported",
        tokens: tool.tokens,
        serverDescription: tool.description,
        annotations: hintsOf(tool.annotations),
        classification: {
          risk: tool.classification.risk,
          sideEffect: tool.classification.sideEffect,
          egress: tool.classification.egress,
          impacts: tool.classification.impacts,
          confirmed: tool.classification.confirmed,
          basis: tool.classification.basis,
        },
        description: tool.importedDescription,
        shaping:
          shape === undefined
            ? null
            : {
                hide: shape.hide,
                fixed: shape.fixed,
                select: shape.select,
                selection: shape.selection,
              },
        feedback: tool.key === null ? null : feedbackOf(feedback.get(tool.key)),
      };
    }),
  };
}

/** The record of a server a steering repo defines, or null. */
export const readStudioRecord: RecordReader = async (
  ctx: WsCtx,
  server: McpServer,
) => {
  if (server.steeringName === null) return null;
  const read = await getStudioServerAction(
    ctx.orgSlug,
    ctx.wsSlug,
    server.steeringName,
  );
  return read.ok ? toStudioRecord(read.value) : null;
};
