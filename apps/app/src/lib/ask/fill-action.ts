"use server";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import type { FormFillOutput } from "@oxagen/oxagen/contracts/form.fill";
import { logger } from "@oxagen/handlers/logger";
import type { FillableFormSpec, FormFillResult } from "./fill-types";

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
 * form.fill capability through the enforced kernel.invoke() path (OXA-1498).
 * Routing through kernel.invoke() ensures the full IAM check + ClickHouse
 * audit write run on every call — matching the behaviour of the API and MCP
 * surfaces (no-drift guarantee).
 *
 * Never throws — on any error returns all fields unchanged so the caller
 * can safely render the result.
 */
export async function fillFormAction(input: FillFormActionInput): Promise<FormFillResult> {
  const noopResult: FormFillResult = {
    fields: input.spec.fields.map((f) => ({
      name: f.name,
      current: f.current,
      proposed: f.current,
      changed: false,
    })),
  };

  try {
    const session = await getSessionOrRedirect();

    const org = await resolveOrg(input.context.orgSlug);

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

    const result = await invoke(
      "form.fill",
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
    ) as FormFillOutput;

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
    logger.error({ err, route: input.context.route }, "fillFormAction failed");
    return noopResult;
  }
}
