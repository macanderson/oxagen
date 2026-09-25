/**
 * `get_assistant_engine`: whether the in-app agent's engine can take a turn
 * (ADR-053 §4; MC spec §4.4). The engine is a required service, so the
 * flyout reads this when it opens and holds Send while the engine reports any
 * state but `ready`. It reads it again on window focus, from its Check again
 * control, and after a turn comes back with an `engine_unavailable` refusal
 * (apps/app `features/shell/use-engine-health.ts`, #3227).
 *
 * The probe is the engine's own readiness route, `GET /readyz`, tried up to
 * three times with a two-second connect timeout each. The answer names what
 * was observed: the state the engine reported, or `unreachable` with the
 * attempts made. Nothing here falls back to an in-process loop.
 *
 * `incident` is null: there is no incident store in rev1
 * (apps/app/ARCHITECTURE.md §1.2 cut Audit beyond the archive at seal), so
 * an unreachable engine is reported here and not filed anywhere. The field
 * stays on the contract so the flyout's incident line has a source when one
 * exists.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

const assistantEngineStateSchema = z.enum([
  "ready",
  "starting",
  "draining",
  "unreachable",
  "unconfigured",
]);

export const assistantEngineGet = registerCapability({
  name: "get_assistant_engine",
  domain: "assistant",
  description:
    "Probe the in-app agent's engine: its readiness state as the engine reported it, or unreachable after the attempts made, with the host the probe was aimed at.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      state: assistantEngineStateSchema,
      /** `host:port` of the engine the probe was aimed at; null when unconfigured. */
      endpoint: z.string().nullable(),
      /** Probe attempts made before the answer. */
      attempts: z.number().int().min(0).max(3),
      /** The error code of the last failed attempt; null when the engine answered. */
      error: z.string().nullable(),
      /** RFC 3339: when the probe answered. */
      checkedAt: z.string().datetime({ offset: true }),
      /** The incident an unreachable engine was filed as; null, there is no store. */
      incident: z.object({ id: z.string() }).strict().nullable(),
    })
    .strict(),
});

export type AssistantEngineGetOutput = z.output<
  typeof assistantEngineGet.output
>;
