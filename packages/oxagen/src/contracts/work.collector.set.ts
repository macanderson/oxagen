/**
 * set_work_collector: create or change a GitHub work collector, or pause and
 * resume one (P1-03, #5103; agent-work-phase-1.html, Screens: Work setup).
 *
 * A collector names one of the workspace's GitHub connections and the
 * repositories whose issues become work items. The row stores the collector
 * as a `collector/v1` document's fields and that document's SHA-256, so the
 * steering file that will carry it later reads the same (ADR-250).
 *
 * Oxagen only reads GitHub. It writes nothing back to an issue. A new or
 * resumed collector reads the repositories at once, and every 15 minutes
 * after that. Pausing keeps each webhook delivery it receives and fetches
 * nothing until a person resumes it.
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
    "Create or change a GitHub work collector by name: the GitHub connection and the repositories whose issues become work items. Pause or resume it with paused.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      /** The GitHub connection's public id (`con_…`). Required to create a collector. */
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
