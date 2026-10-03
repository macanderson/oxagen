/**
 * sync_work_collector: read a work collector's repositories again now
 * (P1-03, #5103). Use it after reconnecting GitHub: a failing collector stops
 * its scheduled reads until a person asks, and a reconcile that finishes
 * moves it back to healthy.
 *
 * The reconcile reads every issue changed since the collector's cursor. It
 * moves the cursor only after each page of issues is stored, so a read that
 * fails partway loses nothing it can read again.
 *
 * Name the collector by its row id or by its name, which is unique in the
 * workspace (P1-05, #5163: the Work setup page names it, so no row id reaches
 * a page). A call that names neither, or both, is refused as invalid input.
 *
 * A sync is a change to the collector, and only a signed-in person changes a
 * collector (Mac, 2026-10-02, #5181; ADR-250, amended 2026-10-03). The
 * handler refuses every API key and every agent run, so the capability is not
 * an MCP tool.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const workCollectorSync = registerCapability({
  name: "sync_work_collector",
  domain: "work",
  description:
    "Queue a reconcile of one work collector now, even when it is failing, such as after reconnecting GitHub.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      collector_id: z.string().uuid().optional(),
      /** The collector's name, as set_work_collector set it. */
      name: z.string().trim().min(1).max(64).optional(),
    })
    .strict(),
  output: z
    .object({
      collector_id: z.string().uuid(),
      queued: z.literal(true),
    })
    .strict(),
});

export type WorkCollectorSyncInput = z.output<typeof workCollectorSync.input>;
export type WorkCollectorSyncOutput = z.output<typeof workCollectorSync.output>;
