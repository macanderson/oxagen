/**
 * set_work_collector: create or change a GitHub work collector, or pause and
 * resume one (P1-03, #5103; agent-work-phase-1.html, Screens: Work setup).
 *
 * A collector names repositories linked to the workspace, whose issues become
 * work items, and reads through the GitHub connection they were linked
 * through. A repository the workspace does not link is refused, and one it
 * unlinks later is no longer read. The row stores the collector
 * as a `collector/v1` document's fields and that document's SHA-256, so the
 * steering file that will carry it later reads the same (ADR-250).
 *
 * A new collector stores every write-back switch off, and a change keeps the
 * switches the row stores, so Oxagen writes nothing back to an issue until a
 * switch is on (#4775). A new or
 * resumed collector reads the repositories at once, and every 15 minutes
 * after that. Pausing keeps each webhook delivery it receives and fetches
 * nothing until a person resumes it.
 *
 * Only a signed-in person changes a collector (Mac, 2026-10-02, #5181;
 * ADR-250). The handler refuses every API key and every agent run, so the
 * capability is not an MCP tool.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryNameSchema, workCollectorSchema } from "./work.intake.shared";

/** The most repositories one collector reads. */
export const WORK_COLLECTOR_REPOS_MAX = 50;

export const workCollectorSet = registerCapability({
  name: "set_work_collector",
  domain: "work",
  description:
    "Create or change a GitHub work collector by name: the linked repositories whose issues become work items. It reads through the GitHub connection they were linked through. Pause or resume it with paused.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      name: z
        .string()
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words joined by single hyphens."),
      /** The GitHub connection's public id (`con_…`). Optional: the repositories' own connection is used, and a different one is refused. */
      connection_id: z.string().min(1).optional(),
      repos: z.array(repositoryNameSchema).min(1).max(WORK_COLLECTOR_REPOS_MAX).optional(),
      paused: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      collector: workCollectorSchema,
      created: z.boolean(),
      /** True when a reconcile was queued: the collector is new, resumed, or reads new repositories. */
      reconcile_queued: z.boolean(),
    })
    .strict(),
});

export type WorkCollectorSetInput = z.output<typeof workCollectorSet.input>;
export type WorkCollectorSetOutput = z.output<typeof workCollectorSet.output>;
