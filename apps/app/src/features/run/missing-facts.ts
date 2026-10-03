// The facts a run did not record that have no slot of their own in the Run
// page's head (run-header spec, Missing facts). The head shows how many there
// are, and the Details drawer lists each one with its reason. A missing fact
// that has a slot, such as the agent or the model, says so in its slot and is
// not counted here.
import type { RunRow } from "@/data/contracts/runs";
import { runEffort } from "./fit";

type Gap = RunRow["completenessGaps"][number];
type EffortWhy = Extract<ReturnType<typeof runEffort>, { seen: false }>["why"];
type FactName =
  | "harness"
  | "harnessVersion"
  | "effort"
  | "machine"
  | "path"
  | "gap";

/** One missing fact: its name and why the record lacks it, as keys under `run`. */
export type MissingFact = {
  /** Unique within one run's list. */
  id: string;
  label: `details.fact.${FactName}`;
  reason:
    | `details.why.${"harness" | "harnessVersion" | "machine" | "path"}`
    | "header.noMachineOnLedger"
    | `header.effortWhy.${EffortWhy}`
    | `gap.${Gap}`;
};

/**
 * Every fact with no slot that the record does not hold.
 *
 * `harness` is the harness the session or the agent registry named, or null
 * when neither did. `work` is what the work read answered: whether the host
 * enrolled a checkout and whether it named the machine. It is null while the
 * read is in flight or after it failed, and then no path is counted as
 * missing, because the read that would hold one has not answered.
 */
export function missingFacts(
  run: RunRow,
  harness: { version: string | null } | null,
  work: { checkout: boolean; machine: boolean } | null,
): MissingFact[] {
  const facts: MissingFact[] = [];
  if (harness === null)
    facts.push({
      id: "harness",
      label: "details.fact.harness",
      reason: "details.why.harness",
    });
  else if (harness.version === null)
    facts.push({
      id: "harnessVersion",
      label: "details.fact.harnessVersion",
      reason: "details.why.harnessVersion",
    });
  const effort = runEffort(run);
  if (!effort.seen)
    facts.push({
      id: "effort",
      label: "details.fact.effort",
      reason: `header.effortWhy.${effort.why}`,
    });
  const machine = run.machine !== null || work?.machine === true;
  if (!machine)
    facts.push({
      id: "machine",
      label: "details.fact.machine",
      reason:
        run.source === "ledger"
          ? "header.noMachineOnLedger"
          : "details.why.machine",
    });
  // A missing machine already says no path is held, so the path is counted
  // only on a known machine.
  else if (
    work !== null &&
    !work.checkout &&
    (run.place?.path ?? null) === null
  )
    facts.push({
      id: "path",
      label: "details.fact.path",
      reason: "details.why.path",
    });
  for (const gap of run.completenessGaps)
    facts.push({
      id: `gap.${gap}`,
      label: "details.fact.gap",
      reason: `gap.${gap}`,
    });
  return facts;
}
