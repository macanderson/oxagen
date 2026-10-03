/**
 * list_work_collectors: the workspace's work collectors, with each one's
 * health, last good read, failed streak, and next check (P1-03, #5103;
 * agent-work-phase-1.html, Delivery and review).
 *
 * Health reads `healthy`, `lagging` when a reconcile found changes a webhook
 * missed or the nightly count differed, `failing` after three failed
 * reconciles in a row, and `paused` when a person paused it. A failing
 * collector waits for a person: sync_work_collector reads it again.
 *
 * `viewer.can_change_collectors` says whether the caller may change a
 * collector (set_work_collector), from the same role check that action makes.
 * An API key and an agent run read false, because set_work_collector refuses
 * them (#5181). The flag decides nothing: set_work_collector checks again.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workCollectorSchema } from "./work.intake.shared";

/** What the caller may do with the collectors, from the role check set_work_collector makes. */
export const workCollectorsViewerSchema = z
  .object({
    /** Create, change, pause, or resume a collector (set_work_collector). */
    can_change_collectors: z.boolean(),
  })
  .strict();

export const workCollectorsList = registerCapability({
  name: "list_work_collectors",
  domain: "work",
  description:
    "List the workspace's work collectors with their repositories, health, last good read, failed reconciles in a row, and next check.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      collectors: z.array(workCollectorSchema),
      viewer: workCollectorsViewerSchema,
    })
    .strict(),
});

export type WorkCollectorsListOutput = z.output<typeof workCollectorsList.output>;
export type WorkCollectorsViewerOutput = z.output<typeof workCollectorsViewerSchema>;
