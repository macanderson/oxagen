"use server";
// The writes on an agent identity (#2956; ADR-057 decision 3) and on its
// definition file (ADR-057 decision 1), each through the kernel seam for the
// workspace viewer the URL names. Every contract here is `noBillingGate` and
// role-checked in its handler (INV-29): rotate, suspend and retire by an org
// Owner or Admin, commit by an Owner, Admin or Member; a refusal comes back as
// `denied` with nothing changed.
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Retires the current key and mints a replacement; the secret is returned once and never again. */
export async function rotateAgentCredential(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ secret: string; expiresAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentCredentialRotate, { agentId });
  return result.ok
    ? {
        ok: true,
        value: {
          secret: result.value.credential.secret,
          expiresAt: result.value.credential.expiresAt,
        },
      }
    : result;
}

/** Suspends the agent, or resumes a suspended one when `suspended` is false. */
export async function setAgentSuspended(
  org: string,
  ws: string,
  agentId: string,
  suspended: boolean,
): Promise<ActionResult<{ status: "suspended" | "active" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentSuspend, { agentId, suspended });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** Retires the identity: its runs keep it, its credentials and host enrollments are revoked. */
export async function retireAgent(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ retiredAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRetire, { agentId });
  return result.ok
    ? { ok: true, value: { retiredAt: result.value.retiredAt } }
    : result;
}

export type DefinitionDraft = {
  agentId: string;
  branch: string;
  /** The commit and pull request title; blank leaves it to the handler. */
  message: string;
  source: string;
};

/** Commits the file to `branch` (never the default branch) and opens, or reuses, its pull request. */
export async function commitAgentDefinition(
  org: string,
  ws: string,
  draft: DefinitionDraft,
): Promise<
  ActionResult<{
    branch: string;
    commitSha: string;
    pullRequest: { number: number; url: string };
  }>
> {
  const ctx = await requireViewer(org, ws);
  const message = draft.message.trim();
  const result = await kernelWrite(ctx, agentDefinitionCommit, {
    agentId: draft.agentId,
    branch: draft.branch.trim(),
    source: draft.source,
    ...(message === "" ? {} : { message }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          branch: result.value.branch,
          commitSha: result.value.commitSha,
          pullRequest: result.value.pullRequest,
        },
      }
    : result;
}
