// steering.published.ts: the published steering search_steering and
// read_steering read (steering-repo-spec, Agent use; #5137).
//
// Both handlers read through `ReadPublished` and `ReadFile`. This binds them
// to the port the Tacho host routes use, `VERSION_STORE_PUBLISHED`, which
// reads the Postgres version store that publish() writes.
//
// That port answers the version published now, for a call with no run id.
// The MCP surface carries no run id, so every call there reads the version
// published now, as steering.search.ts specifies for a call from outside a
// run. A run has to read the versions its request manifest names, and
// nothing reads those pins back yet (tacho.published.ts). So a call that
// names a run is refused instead of being answered from a version the run
// may never have been delivered.
import { HandlerError } from "@oxagen/oxagen";
import type { ReadFile } from "@oxagen/steering-bundle";
import type { ReadPublished } from "./steering.search";
import { VERSION_STORE_PUBLISHED, type TachoPublished } from "./tacho.published";

/** What the two steering tools read through. */
export interface SteeringToolsPublished {
  published: ReadPublished;
  readFile: ReadFile;
}

/** The refusal for a call from a run, whose delivered versions are not recorded. */
export function runVersionsUnrecorded(runId: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "steering_run_versions_unrecorded",
    message: `Oxagen does not record which steering versions run ${runId} received, so it cannot read them. Call this tool from outside a run to read the steering published now.`,
  });
}

/** The two steering tools' reads over one host port. */
export function steeringToolsPublished(
  port: TachoPublished = VERSION_STORE_PUBLISHED,
): SteeringToolsPublished {
  return {
    published: async (scope) => {
      if (scope.runId !== null) throw runVersionsUnrecorded(scope.runId);
      return port.published({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        runId: null,
      });
    },
    // A record and a skill file reach the model as text. The Postgres
    // binding reads each file as UTF-8 text already, so the decode only
    // covers a port that hands back bytes.
    readFile: async (source, bundle, file) => {
      const content = await port.readAsset(source, bundle, file);
      return typeof content === "string" ? content : new TextDecoder().decode(content);
    },
  };
}

/** The reads the registered handlers use. */
export const STEERING_TOOLS_PUBLISHED: SteeringToolsPublished = steeringToolsPublished();
