"use server";
// The one write on the Runtimes pages: Unenroll on a runtime's Rollback panel.
//
// The record holds an enrollment per agent, so Unenroll revokes the enrollment
// the page is showing, which is one agent on one machine, through
// `revoke_tacho_enrollment`. The spec's `runtime.unenroll` names the governed
// action; this contract is its binding today. It is `noBillingGate`, admits an
// org Owner or Admin in its handler (INV-29), and lands in the audit record
// through the kernel. A refusal comes back `denied` with nothing changed.
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Revokes one host enrollment; its key is retired and sessions on it are denied at their next boundary. */
export async function unenrollRuntime(
  org: string,
  ws: string,
  runtimeId: string,
): Promise<ActionResult<{ revokedAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, tachoEnrollmentRevoke, {
    hostEnrollmentId: runtimeId,
  });
  return result.ok
    ? { ok: true, value: { revokedAt: result.value.revokedAt } }
    : result;
}
