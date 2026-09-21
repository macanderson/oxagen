"use server";
// The one write this page makes (#3395; ADR-061; MC spec §10.3): change what a
// published record says, as a pull request.
//
// Nothing here writes a row. `revise_context_record` raises a proposal carrying
// the record's kind, force, effect and scope exactly as they stand, then hands
// it to `open_context_pr`, which commits the record's file to a branch of its
// own, opens the pull request and runs the six §10.3 checks. The record in
// force does not move until that pull request merges, which is the same way it
// was published.
//
// The contract is `noBillingGate`, and its handler gates the acting user's
// role (INV-29): an org Owner or Admin, or a workspace Owner or Member,
// revises; anyone else is answered `denied` with nothing changed.
import { contextRecordRevise } from "@oxagen/oxagen/contracts/context.record.revise";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

type Revised = {
  /** Where the Context PR machine stopped: `checks_passed` is ready to merge. */
  status: ContractOutput<typeof contextRecordRevise>["status"];
  prNumber: number | null;
  prUrl: string | null;
};

export async function reviseRecord(
  org: string,
  ws: string,
  lineage: string,
  statement: string,
  rationale: string,
): Promise<ActionResult<Revised>> {
  const ctx = await requireViewer(org, ws);
  const reason = rationale.trim();
  const result = await kernelWrite(ctx, contextRecordRevise, {
    recordId: lineage,
    statement: statement.trim(),
    ...(reason === "" ? {} : { rationale: reason }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          status: result.value.status,
          prNumber: result.value.pr?.number ?? null,
          prUrl: result.value.pr?.url ?? null,
        },
      }
    : result;
}
