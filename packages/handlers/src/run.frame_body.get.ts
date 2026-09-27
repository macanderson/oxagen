// `get_run_frame_body`: one frame's redacted body, read on demand (ADR-058).
//
// The frame is located through the run reader (lib/run-read.ts), so the
// tenant fence is the one every read of a recording uses. A subagent's frame
// is located by its chain and seq, and the chain is read under the run's root
// session, so a chain of another run is `not_found` (#3823). A frame that
// carried no content is `not_found`; a frame whose body the workspace's
// retention policy kept as a digest alone answers the digest with no bytes;
// a retained body is read from the evidence store by the reference the row
// holds, and its bytes are checked against the recorded digest before they
// leave, so a store that answered the wrong object cannot pass as the record.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runFrameBodyGet,
  type RunFrameBodyGetOutput,
} from "@oxagen/oxagen/contracts/run.frame_body.get";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import { selectTachoSubagentEvents } from "@oxagen/telemetry";
import { runScope } from "./run.list";
import {
  defaultRunReadDeps,
  readFrameAt,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

export type RunFrameBodyGetDeps = RunReadDeps & {
  /**
   * Required here, where `RunReadDeps` leaves it optional: a subagent's frame
   * is read through it, and a handler built without it could open none.
   */
  tachoSubagentFrames: NonNullable<RunReadDeps["tachoSubagentFrames"]>;
  bodies: Pick<EvidenceStore, "getBody">;
};

export function createRunFrameBodyGetHandler(
  deps: RunFrameBodyGetDeps,
): CapabilityHandler<typeof runFrameBodyGet> {
  return async (input, ctx): Promise<RunFrameBodyGetOutput> => {
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const frame = await readFrameAt(deps, run, input.seq, input.sessionUuid);
    if (!frame) {
      throw new HandlerError({ code: "not_found", reason: "frame_not_found" });
    }
    const { body } = frame;
    if (body.bodyDigest === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "frame_has_no_body",
      });
    }
    const redactions = (body.redactions ?? []).map((r) => ({
      path: r.path,
      reason: r.reason,
      originalDigest: r.original_digest,
    }));
    if (body.bodyRef === null) {
      return {
        contentType: null,
        bytes: null,
        digest: body.bodyDigest,
        redactions,
      };
    }
    const stored = await deps.bodies.getBody(scope, body.bodyRef);
    if (digestBytes(stored.bytes) !== body.bodyDigest) {
      throw new Error(
        `evidence body ${body.bodyRef} does not hash to the recorded digest ${body.bodyDigest}`,
      );
    }
    return {
      contentType: stored.contentType,
      bytes: Buffer.from(stored.bytes).toString("base64"),
      digest: body.bodyDigest,
      redactions,
    };
  };
}

export const runFrameBodyGetHandler = createRunFrameBodyGetHandler({
  ...defaultRunReadDeps(),
  tachoSubagentFrames: selectTachoSubagentEvents,
  get bodies() {
    return evidenceStore();
  },
});
