/**
 * sync_work_collector: read a work collector's repositories again now
 * (P1-03, #5103). Use it after reconnecting GitHub: a failing collector stops
 * its scheduled reads until a person asks, and a reconcile that finishes
 * moves it back to healthy.
 *
 * The reconcile reads every issue changed since the collector's cursor. It
 * moves the cursor only after each page of issues is stored, so a read that
 * fails partway loses nothing it can read again.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const workCollectorSync = registerCapability({
  name: "sync_work_collector",
  domain: "work",
  description:
    "Queue a reconcile of one work collector now, even when it is failing, such as after reconnecting GitHub.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ collector_id: z.string().uuid() }).strict(),
  output: z
    .object({
      collector_id: z.string().uuid(),
      queued: z.literal(true),
    })
    .strict(),
});

export type WorkCollectorSyncInput = z.output<typeof workCollectorSync.input>;
export type WorkCollectorSyncOutput = z.output<typeof workCollectorSync.output>;
