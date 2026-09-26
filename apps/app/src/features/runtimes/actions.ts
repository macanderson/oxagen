"use server";
// The writes on the Runtimes pages: Add a runtime on the list, and Unenroll on
// a runtime's Rollback panel.
//
// Add a runtime names a runtime (`create_runtime`, ADR-198) and hands the
// person straight to registering its first agent, because a runtime with no
// agent governs nothing. The register flow opens with the runtime chosen.
//
// Unenroll revokes the one host enrollment the page is showing through
// `revoke_tacho_enrollment`. The spec's `runtime.unenroll` names the governed
// action; this contract is its binding today.
//
// Both are `noBillingGate`, admit an org Owner or Admin in their handlers
// (INV-29), and land in the audit record through the kernel. A refusal comes
// back as the seam classified it, with nothing changed.
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";

export type CreatedRuntime = {
  id: string;
  name: string;
  slug: string;
  /** The register flow's first step with this runtime chosen. */
  register: SafePath;
};

/**
 * Names a runtime and answers where its first agent is registered. A slug
 * another live runtime holds comes back `conflict` with code
 * `runtime_slug_taken`, which the form names on the Slug field.
 */
export async function createRuntime(
  org: string,
  ws: string,
  input: { name: string; slug: string },
): Promise<ActionResult<CreatedRuntime>> {
  const ctx = await requireViewer(org, ws);
  const name = input.name.trim();
  const slug = input.slug.trim();
  const result = await kernelWrite(ctx, runtimeCreate, {
    name,
    ...(slug === "" ? {} : { slug }),
  });
  if (!result.ok) return result;
  const { runtime } = result.value;
  return {
    ok: true,
    value: {
      id: runtime.id,
      name: runtime.name,
      slug: runtime.slug,
      register: routes.register(ctx.orgSlug, ctx.wsSlug, "name", {
        runtime: runtime.id,
      }),
    },
  };
}

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
