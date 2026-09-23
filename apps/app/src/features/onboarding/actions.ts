"use server";
// The writes behind organization creation and Register an agent (#2967,
// ADR-065), each through the kernel seam for the viewer the URL names. Every
// contract here is `noBillingGate` and role-checked in its handler (INV-29):
// `register_agent`, `create_enrollment_token`, `advance_onboarding` and
// `bind_main_repository` admit an org Owner or Admin, and a refusal comes back
// as `denied` with nothing written.
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { onboardingAdvance } from "@oxagen/oxagen/contracts/onboarding.advance";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireUser, requireViewer } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { AgentForm, type AgentFormValues } from "./agent-form";
import { OrganizationForm, type OrganizationField } from "./org-form";

/**
 * A field the form refuses is `invalid` with the field and its
 * `onboarding.errors` key as the code, and no capability runs. A taken address
 * is the handler's `conflict` with code `slug_taken`.
 */
export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
): Promise<ActionResult<{ to: SafePath }>> {
  const ctx = await requireUser(routes.newOrganization());
  const parsed = OrganizationForm.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const { name, slug, workspaceName, workspaceSlug } = parsed.data;
  const result = await kernelWrite(ctx, organizationCreate, {
    name,
    slug,
    workspace: { name: workspaceName, slug: workspaceSlug },
  });
  return result.ok
    ? {
        ok: true,
        value: {
          to: routes.fleet(result.value.slug, result.value.workspace.slug),
        },
      }
    : result;
}

export type RegisteredAgent = {
  agentId: string;
  agentKey: string | null;
  /** The wrap step for this identity. */
  to: SafePath;
};

/**
 * Mints the identity, its delegated principal and its long-lived credential.
 * The definition file is committed separately, so registration writes none.
 * The credential's secret stays on the server: the register gate shows none
 * on the name step, and the SDK path issues its own with
 * `rotate_agent_credential` when the operator asks for it.
 */
export async function registerAgent(
  org: string,
  ws: string,
  input: AgentFormValues,
): Promise<ActionResult<RegisteredAgent>> {
  const ctx = await requireViewer(org, ws);
  const parsed = AgentForm.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const { slug, name, description, harness } = parsed.data;
  const result = await kernelWrite(ctx, agentRegister, {
    slug,
    name,
    harness,
    ...(description === "" ? {} : { description }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          agentId: result.value.agentId,
          agentKey: result.value.agentKey,
          to: routes.register(org, ws, "wrap", {
            agent: result.value.agentId,
          }),
        },
      }
    : result;
}

export type EnrollmentToken = {
  /** Shown once. A token that expires unused is replaced by issuing another. */
  token: string;
  expiresAt: string;
  agentKey: string;
  /** `oxagen agent enroll --token …`, the scripted path (spec §14.1). */
  enrollCommand: string;
};

/** Mints the single-use token a machine presents to `enroll_host` to become this agent's host. */
export async function issueEnrollmentToken(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<EnrollmentToken>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, tachoEnrollmentTokenCreate, {
    agentId,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          token: result.value.token,
          expiresAt: result.value.expiresAt,
          agentKey: result.value.agentKey,
          enrollCommand: result.value.enrollCommand,
        },
      }
    : result;
}

/**
 * Moves the gate between its wrap and run steps. `unlocked` is the ingest's
 * alone, so this never completes the run step; a workspace that is not the
 * gate's answers `not_found` with code `gate_not_found`.
 */
export async function advanceOnboarding(
  org: string,
  ws: string,
  to: "wrap" | "run",
): Promise<ActionResult<{ step: string; changedAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, onboardingAdvance, { to });
  return result.ok
    ? {
        ok: true,
        value: { step: result.value.step, changedAt: result.value.changedAt },
      }
    : result;
}

export type BoundRepository = {
  fullName: string;
  defaultRef: string;
  boundAt: string;
  /** True when this call closed the gate's provisional window. */
  provisionalClosed: boolean;
};

/**
 * Binds the repository the enrolling host reported as the workspace's main
 * repo and closes the provisional window. The GitHub App installation comes
 * from the workspace's connection, so the caller names only the repository.
 */
export async function bindMainRepository(
  org: string,
  ws: string,
  repository: { owner: string; name: string },
): Promise<ActionResult<BoundRepository>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryMainBind, {
    owner: repository.owner,
    name: repository.name,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          fullName: result.value.fullName,
          defaultRef: result.value.defaultRef,
          boundAt: result.value.boundAt,
          provisionalClosed: result.value.provisionalClosed,
        },
      }
    : result;
}
