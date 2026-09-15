// A page of runs as the Fleet runs table reads it (ARCHITECTURE.md §1.2),
// from `list_runs`. A field is nullable exactly where the contract may not have
// recorded it (§3.4); a null renders as "not recorded".
import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";

/** `live`: open. `sealed`: ended with a sealed record. `halted`: an operator or policy stopped it. */
export const RunStatus = z.enum(["live", "sealed", "halted"]);
export type RunStatus = z.infer<typeof RunStatus>;

const RunRow = z.object({
  id: PublicId,
  /** Which store recorded the run: the evidence ledger or a wrapped agent's session. */
  source: z.enum(["ledger", "tacho"]),
  /** `org_ns.ws_ns.slug` (ADR-024). */
  agentKey: z.string().min(1).nullable(),
  operatorId: PublicId.nullable(),
  status: RunStatus,
  frames: z.number().int().nonnegative(),
  cost: Cost.nullable(),
  taskRef: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
});

export const RunPage = z.object({
  runs: z.array(RunRow),
  /** Opaque; the next page's cursor, null on the last page. */
  nextCursor: z.string().nullable(),
});
export type RunPage = z.infer<typeof RunPage>;
