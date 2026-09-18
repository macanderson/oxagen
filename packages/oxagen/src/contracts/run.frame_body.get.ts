/**
 * `get_run_frame_body`: the content one frame is about (Mission Control spec
 * §8.2, §8.4 `view`; ADR-058).
 *
 * `get_run` carries every frame's body reference and never its bytes (§3.5:
 * bodies are fetched on demand, never streamed). This capability reads one
 * body by the reference the frame row holds, inside the tenant scope, from
 * the organisation's evidence store. The bytes come back exactly as the
 * recorder wrote them after redaction, so a caller can recompute `digest`
 * and prove what it read is what was recorded.
 *
 * A frame recorded under a `digest_only` retention policy answers its digest
 * and `bytes: null`: the workspace chose to keep no bodies, and the read says
 * so rather than failing. A frame that carried no content at all is
 * `not_found`: there is no body to ask for.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { frameRedactionSchema } from "./run.get";
import { runPublicIdSchema } from "./run.list";

/** A frame's position: `run_seq` (ledger) or `seq` (wrapped), decimal. */
export const frameSeqSchema = z.string().regex(/^\d{1,19}$/);

export const runFrameBodyGet = registerCapability({
  name: "get_run_frame_body",
  domain: "run",
  description:
    "Read the redacted body of one frame of a run by its sequence: the content type and bytes when the workspace retained bodies, the digest and no bytes under digest_only.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
      seq: frameSeqSchema,
    })
    .strict(),
  output: z
    .object({
      /** Null exactly when `bytes` is null. */
      contentType: z.string().nullable(),
      /** The redacted bytes, base64; null when no body was retained. */
      bytes: z.string().nullable(),
      /** sha256 over the redacted bytes, recorded at write. */
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      redactions: z.array(frameRedactionSchema),
    })
    .strict(),
});

export type RunFrameBodyGetInput = z.output<typeof runFrameBodyGet.input>;
export type RunFrameBodyGetOutput = z.output<typeof runFrameBodyGet.output>;
