/**
 * The memories most relevant to one prompt on an enrolled host, asked for by
 * the Tacho daemon once per prompt (ADR-206). The answer holds active memory
 * records from the workspace's and the organization's published steering,
 * and waiting memories where the workspace's governance lets them be
 * recalled before review. Each record served counts as recalled, which keeps
 * it from going stale, so the call writes.
 *
 * Machine-to-machine, authenticated by the host's API key. The host names
 * itself so the handler can check the key's scope names the same host.
 */
import { SHA256_DIGEST_PATTERN } from "@oxagen/tacho";
import { z } from "zod";
import { registerCapability } from "../registry";
import { MEMORY_RECALL_MAX } from "../steering-repo/tokens";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

export const tachoMemoriesRecall = registerCapability({
  name: "recall_tacho_memories",
  domain: "tacho",
  description:
    "Return the memories most relevant to one prompt on an enrolled Tacho host.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  // Recall stamps each record it serves, so the record does not go stale.
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      /**
       * The digests of the repository the prompt runs in, as the host
       * computes them from its `origin` remote: `canonicalRemote`, then
       * `foldedRemote`, each through `digestBytes`. The remote stays on the
       * host. Empty outside a repository, and then a record scoped to
       * repositories is left out.
       */
      repository_digests: z
        .array(z.string().regex(SHA256_DIGEST_PATTERN))
        .max(8),
      /** The tools the session has called, most recent first. */
      tools: z.array(z.string().min(1).max(200)).max(64),
      /**
       * The files the session has touched, most recent first, relative to
       * the repository root.
       */
      paths: z.array(z.string().min(1).max(512)).max(64),
      /** The prompt's text. It may be empty. */
      text: z.string().max(8000),
    })
    .strict(),
  output: z
    .object({
      /** Most relevant first. */
      items: z
        .array(
          z
            .object({
              /** A record's lineage, or a waiting memory's public id. */
              id: z.string().min(1),
              /** `record` for a merged memory record, `memory` for one waiting for review. */
              source: z.enum(["record", "memory"]),
              statement: z.string(),
              score: z.number(),
              tokens: z.number().int().min(0),
            })
            .strict(),
        )
        .max(MEMORY_RECALL_MAX),
    })
    .strict(),
});

export type TachoMemoriesRecallInput = z.output<
  typeof tachoMemoriesRecall.input
>;
export type TachoMemoriesRecallOutput = z.output<
  typeof tachoMemoriesRecall.output
>;
