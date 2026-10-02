/**
 * get_work_priorities: the priorities record triage ranks by, at the version
 * it reads, and how triage has fared in the last 30 days (P1-03, #5103;
 * agent-work-phase-1.html, Screens: Work setup).
 *
 * The priorities record is a steering record whose lineage is
 * `work.priorities` or ends in `.work.priorities`. A person edits it with a
 * Context PR (open_context_pr), and triage reads each new version after it
 * merges. With no such record, or more than one, `record` is null and
 * `problem` says what to fix.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const workPrioritiesGet = registerCapability({
  name: "get_work_priorities",
  domain: "work",
  description:
    "Read the priorities record triage ranks work by: its lineage, version, hash, and numbered rules, with triage's suggestions, corrections, and failures in the last 30 days.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      record: z
        .object({
          lineage: z.string(),
          /** The steering record's public id. */
          record_id: z.string(),
          version: z.number().int().positive(),
          /** The SHA-256 triage stores on each decision. */
          hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          rules: z.array(z.object({ number: z.number().int().nonnegative(), text: z.string() }).strict()),
          published_at: z.string().nullable(),
        })
        .strict()
        .nullable(),
      /** Why triage cannot rank work, or null when the record is in place. */
      problem: z.string().nullable(),
      /** Counts over the last 30 days. */
      last_30_days: z
        .object({
          suggestions: z.number().int().nonnegative(),
          failures: z.number().int().nonnegative(),
          corrections: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
});

export type WorkPrioritiesGetOutput = z.output<typeof workPrioritiesGet.output>;
