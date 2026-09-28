"use server";
// The writes behind organization creation, the first workspace and Register an
// agent (#2967, ADR-065, lane S7 #4518), each through the kernel seam for the
// viewer the URL names. Every contract here is role-checked in its handler
// (INV-29): `create_workspace`, `register_agent`, `create_enrollment_token`
// and `advance_onboarding` admit an org Owner or Admin, and a refusal comes
// back as `denied` with nothing written.
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { onboardingAdvance } from "@oxagen/oxagen/contracts/onboarding.advance";
import {
  DEFAULT_FIRST_WORKSPACE,
  organizationCreate,
  slugFromName,
} from "@oxagen/oxagen/contracts/org.create";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireUser, requireViewer } from "@/server/viewer";
import { routes, type SafePath, sanitizeNext } from "@/shared/safe-path";
import { AgentForm, type AgentFormValues } from "./agent-form";
import { OrganizationForm, type OrganizationField } from "./org-form";

/**
 * A field the form refuses is `invalid` with the field and its
 * `onboarding.errors` key as the code, and no capability runs. A taken address
 * is the handler's `conflict` with code `slug_taken`, a taken namespace the
 * same with `namespace_taken`.
 *
 * With no `destination`, a created organization continues to the connect step:
 * a workspace needs a steering repo, and a steering repo needs a code host, so
 * the form names no workspace. It sends `workspace: null`, so `create_org`
 * makes none and the welcome flow asks for the first one by name (#4582).
 *
 * A `destination` (the CLI consent page) skips the welcome flow, so nothing
 * would ever ask for that name. The organization gets `create_org`'s "Default"
 * workspace instead, because the consent page lists only organizations that
 * have a workspace and would send you back here. The destination comes from
 * the client, so it is sanitized again here, and one that fails falls back to
 * the connect step.
 */
export async function createOrganizationAction(
  input: Record<OrganizationField, string>,
  destination?: string,
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
  const { name, slug, namespace } = parsed.data;
  const next = sanitizeNext(destination ?? null, routes.root());
  const skipsWelcome = next !== routes.root();
  const result = await kernelWrite(ctx, organizationCreate, {
    name,
    slug,
    namespace,
    workspace: skipsWelcome ? DEFAULT_FIRST_WORKSPACE : null,
  });
  if (!result.ok) return result;
  // Otherwise the gate's next step is Connect a code host, outside the app
  // shell. The first workspace follows it, and Fleet opens once the first
  // frame arrives.
  return {
    ok: true,
    value: {
      to: skipsWelcome ? next : routes.welcomeConnect(result.value.slug),
    },
  };
}

/** The longest workspace name `create_workspace` takes. */
const WORKSPACE_NAME_MAX = 120;

/**
 * The organization's first workspace, from its name alone. The slug is made
 * from the name (`slugFromName`), so a slug the contract refuses or finds
 * taken is the name's to fix: an invalid `slug` comes back on `name`, and a
 * taken one is the handler's `conflict` with code `slug_taken`.
 * `create_workspace` starts the steering repo job and answers before the
 * repository exists. The page then shows the job's progress.
 */
export async function createFirstWorkspace(
  org: string,
  name: string,
): Promise<ActionResult<{ slug: string }>> {
  const ctx = await requireViewer(org);
  const trimmed = name.trim();
  if (trimmed === "")
    return {
      ok: false,
      reason: "invalid",
      code: "name_required",
      field: "name",
    };
  if (trimmed.length > WORKSPACE_NAME_MAX)
    return {
      ok: false,
      reason: "invalid",
      code: "name_too_long",
      field: "name",
    };
  const result = await kernelWrite(ctx, workspaceCreate, {
    name: trimmed,
    slug: slugFromName(trimmed),
  });
  if (result.ok) return { ok: true, value: { slug: result.value.slug } };
  if (result.reason === "invalid" && result.field === "slug")
    return { ...result, field: "name" };
  return result;
}

export type RegisteredAgent = {
  agentId: string;
  agentKey: string | null;
  /** The wrap step for this identity. */
  to: SafePath;
};

/**
 * Mints the agent (ADR-198): one operator on one runtime with one harness,
 * carrying a toolbelt, with its delegated principal, its first version and its
 * long-lived credential. An empty toolbelt is the workspace's All tools belt.
 * A runtime and harness pair a live agent holds comes back `conflict` with
 * code `runtime_harness_taken`, a slug the workspace has ever used with
 * `agent_slug_taken`. The credential's secret stays on the server: the
 * register gate shows none on the name step, and the SDK path issues its own
 * with `rotate_agent_credential` when the operator asks for it.
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
  const { slug, name, harness, runtimeId, toolbeltId } = parsed.data;
  const result = await kernelWrite(ctx, agentRegister, {
    name,
    slug,
    harness,
    runtimeId,
    ...(toolbeltId === "" ? {} : { toolbeltId }),
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
