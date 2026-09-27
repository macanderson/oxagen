/**
 * `bisect_runs`: the first frame at which two runs diverge (Mission Control
 * spec §8.4 "bisect between any two runs of the same task"; ADR-058).
 *
 * Both runs are read as their frames, in sequence, and each frame is reduced
 * to a bisect key: its kind, then the identity of what it did — the tool and
 * its status for a tool call, the model for a model call, the outcome for a
 * policy decision, the verdict for a proof, the row count for an assembled
 * context. The first position whose keys differ is the divergence; two runs
 * whose keys agree at every position, and have the same length, answer
 * `divergentSeq: null`. A run that is a strict prefix of the other diverges
 * at the first frame the longer one has alone, and the shorter run's key
 * there is null.
 *
 * A wrapped run is read as every chain it recorded, each subagent chain
 * placed after the `subagent_start` that spawned it, with every frame kept
 * (#3823). A divergence on a subagent's frame names that chain in
 * `divergentSessionUuid`, because a subagent chain numbers its frames from 0
 * and `divergentSeq` alone would name a frame on the run's own chain.
 *
 * Bodies are not read: the key is built from the frame's recorded receipt,
 * so bisect works at grade `inspect` and above.
 *
 * `noBillingGate: true`: reading recordings is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

export const runBisect = registerCapability({
  name: "bisect_runs",
  domain: "run",
  description:
    "Align two runs frame by frame on each frame's kind and call identity and answer the first sequence at which they diverge, with both keys there; null when they agree throughout.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runA: runPublicIdSchema,
      runB: runPublicIdSchema,
    })
    .strict(),
  output: z
    .object({
      /** The position of the first differing frame; null when none differs. */
      divergentSeq: z.string().regex(/^\d+$/).nullable(),
      /**
       * The subagent chain `divergentSeq` lies on, in whichever run it names a
       * frame. Absent when that frame is on the run's own chain.
       */
      divergentSessionUuid: z.string().uuid().optional(),
      /** Run A's key at that position; null when A has no frame there. */
      keyA: z.string().nullable(),
      /** Run B's key at that position; null when B has no frame there. */
      keyB: z.string().nullable(),
      /** Frames compared before the divergence, or in total when none. */
      aligned: z.number().int().nonnegative(),
    })
    .strict(),
});

export type RunBisectInput = z.output<typeof runBisect.input>;
export type RunBisectOutput = z.output<typeof runBisect.output>;
