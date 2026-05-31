"use server";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { formFillHandler } from "@oxagen/handlers/form.fill";
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
 * form.fill handler to produce field-level diffs for the given spec and
 * instruction.
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

    const result = await formFillHandler(
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
    );

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
  } catch {
    // Policy §0.5: never throw from a server action that has a safe fallback.
    return noopResult;
  }
}
