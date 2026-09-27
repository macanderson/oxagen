// steering.read.ts: the steering_read MCP tool (steering-repo-spec, Agent
// use).
//
// An agent calls it to read one record the run's index listed, or one file
// from a skill's folder. The record comes back as the model reads it: a
// heading with the label, then the body with its @tool: mentions rendered in
// the version's exposure modes. The frontmatter never comes back. The
// workspace's record wins over an organization record of the same lineage.
//
// A lineage neither published version holds refuses as
// `not_found: steering_record_not_found`. A file the skill's folder does not
// hold refuses as `not_found: steering_file_not_found`.
//
// The handler is a factory, for the same reason as steering.search.ts.
import type { CheckedContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  readSteering,
  steeringReadInputSchema,
  type ReadFile,
  type SteeringReadMiss,
  type SteeringReadOutput,
} from "@oxagen/steering-bundle";
import { steeringScope, type ReadPublished } from "./steering.search";

export interface SteeringReadDeps {
  published: ReadPublished;
  /** Reads one file of a published version by its blob. */
  readFile: ReadFile;
}

export type SteeringReadHandler = (
  input: unknown,
  ctx: CheckedContext,
) => Promise<SteeringReadOutput>;

/** The refusal for a read that found nothing. */
export function steeringReadMiss(
  miss: SteeringReadMiss,
  lineage: string,
  file: string | undefined,
): HandlerError {
  if (miss === "record_not_found") {
    return new HandlerError({
      code: "not_found",
      reason: "steering_record_not_found",
      message: `No published steering version holds ${lineage}. Find the lineage with steering_search.`,
    });
  }
  return new HandlerError({
    code: "not_found",
    reason: "steering_file_not_found",
    message: `${lineage} has no file named ${file ?? "(none)"}. Name a file in the skill's folder, such as words.md.`,
  });
}

export function createSteeringReadHandler(deps: SteeringReadDeps): SteeringReadHandler {
  return async (input, ctx) => {
    const parsed = steeringReadInputSchema.parse(input);
    const delivery = await deps.published(steeringScope(ctx));
    const result = await readSteering(delivery, parsed, deps.readFile);
    if (!result.found) throw steeringReadMiss(result.miss, parsed.lineage, parsed.file);
    return result.output;
  };
}
