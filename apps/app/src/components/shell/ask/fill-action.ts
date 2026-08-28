"use server";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, getOrgRole } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import {
  formFill,
  type FormFillOutput,
} from "@oxagen/oxagen/contracts/form.fill";
import { logger } from "@oxagen/handlers/logger";
import type { FillableFormSpec, FormFillResult } from "@/lib/ask/fill-types";

export interface FillFormActionInput {
  spec: FillableFormSpec;
  instruction: string;
  context: {
    orgSlug: string;
    workspaceSlug?: string;
    route: string;
    entitySummary?: string;
  };
}

/**
 * Server action: resolve tenant context from the session, then invoke the
 * form.fill capability through the enforced kernel.invoke() path.
 * Routing through kernel.invoke() ensures the full IAM check + ClickHouse
 * audit write run on every call — matching the behaviour of the API and MCP
 * surfaces (no-drift guarantee).
 *
 * Never throws — on any error returns all fields unchanged so the caller can
 * safely render the result. The fallback carries an `error` field so the caller
 * can distinguish a swallowed auth/IAM/billing denial from a legitimate
 * "no changes proposed" result and surface an actionable message.
 */
export async function fillFormAction(
  input: FillFormActionInput,
): Promise<FormFillResult> {
  const noopFields = input.spec.fields.map((f) => ({
    name: f.name,
    current: f.current,
    proposed: f.current,
    changed: false,
  }));

  try {
    const session = await getSessionOrRedirect();

    const org = await resolveOrg(input.context.orgSlug);

    // resolveOrg only maps slug→id, and invoke() from apps/app does NOT run the
    // IAM membership check (the kernel skips it on the app surface). Gate org
    // membership here so a session scoped to org A cannot drive form.fill
    // against org B by passing its slug. Non-throwing (returns the safe no-op)
    // to honour this action's never-throw contract.
    const memberRole = await getOrgRole(org.id, session.user.id);
    if (!memberRole) {
      return {
        fields: noopFields,
        error: "You do not have access to this organization.",
      };
    }

    let workspaceId = "";
    if (input.context.workspaceSlug) {
      const ws = await resolveWorkspace(org.id, input.context.workspaceSlug);
      workspaceId = ws.id;
    }

    const ctx = {
      orgId: org.id,
      workspaceId,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    const rawResult = await invoke(
      "fill_form",
      {
        route: input.context.route,
        entitySummary: input.context.entitySummary,
        instruction: input.instruction,
        fields: input.spec.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          current: f.current,
          options: f.options,
          required: f.required,
        })),
      },
      ctx,
      { surface: "agent" },
    );
    const result: FormFillOutput = formFill.output.parse(rawResult);

    // Explicitly map to FieldDiff to satisfy required `current` / `proposed`
    // (the Zod-inferred type treats z.unknown() as optional).
    const fields = result.fields.map((f) => ({
      name: f.name,
      current: f.current,
      proposed: f.proposed,
      changed: f.changed,
      ...(typeof f.reason === "string" ? { reason: f.reason } : {}),
    }));
    return { fields };
  } catch (err) {
    // Policy §0.5: never throw from a server action that has a safe fallback.
    // But DO carry an `error` so the caller can distinguish this swallowed
    // failure (auth/IAM/billing denial, capability error) from a legitimate
    // "no changes proposed" result and surface an actionable message.
    logger.error({ err, route: input.context.route }, "fillFormAction failed");
    const message =
      err instanceof Error
        ? err.message
        : "Unable to fill the form. Please try again.";
    return { fields: noopFields, error: message };
  }
}
