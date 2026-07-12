"use server";

/**
 * actions.ts — server actions for Workspace → Evals: dataset create (manual +
 * from-traces), item add, dataset detail read, run start, and run status poll.
 *
 * Follows the same pattern as knowledge/memories/actions.ts and
 * settings/general/actions.ts:
 *   1. getSessionOrRedirect() → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR-safe org/workspace resolution
 *   3. assertOrgMember() → org membership guard
 *   4. a local workspace-role gate (apps/app does NOT bootstrap IAM — invoke()
 *      skips role checks in-app) — assertWorkspaceWriter (Owner/Member, the
 *      role set every eval mutation contract's defaultRoles.workspace allows)
 *      for mutations, assertWorkspaceReader (Owner/Member/Viewer) for reads
 *   5. invoke() with NO surface option — every eval.* contract's `surfaces`
 *      list is ["api","mcp","cli"] and does not include "app"; passing any
 *      surface opt throws surface_denied (see datasets-section.tsx)
 *   6. revalidatePath() on mutations that change what the dataset list shows
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { withTenantDb, schema } from "@oxagen/database";
import { logger } from "@oxagen/handlers/logger";
import { evalTargetSchema, type EvalTarget } from "@oxagen/oxagen/contracts/eval-schema";
import type { EvalDatasetCreateOutput } from "@oxagen/oxagen/contracts/eval.dataset.create";
import type { EvalDatasetFromTracesOutput } from "@oxagen/oxagen/contracts/eval.dataset.from_traces";
import type { EvalDatasetItemAddOutput } from "@oxagen/oxagen/contracts/eval.dataset_item.add";
import type { EvalDatasetGetOutput } from "@oxagen/oxagen/contracts/eval.dataset.get";
import type { EvalRunStartOutput } from "@oxagen/oxagen/contracts/eval.run.start";
import type { EvalRunStatusOutput } from "@oxagen/oxagen/contracts/eval.run.status";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type CreateDatasetResult =
  | { ok: true; datasetId: string; publicId: string; slug: string }
  | { ok: false; error: string };

export type CreateTraceDatasetResult =
  | { ok: true; datasetId: string; publicId: string; slug: string; itemCount: number }
  | { ok: false; error: string };

export type AddDatasetItemResult =
  | { ok: true; datasetId: string; added: number; itemCount: number }
  | { ok: false; error: string };

export type GetDatasetResult =
  | {
      ok: true;
      dataset: EvalDatasetGetOutput["dataset"];
      items: EvalDatasetGetOutput["items"];
      nextCursor: string | null;
    }
  | { ok: false; error: string };

export type StartEvalRunResult =
  | { ok: true; runId: string; itemCount: number }
  | { ok: false; error: string };

export type GetEvalRunStatusResult =
  | { ok: true; status: EvalRunStatusOutput }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Shared workspace-role gates
//
// apps/app never bootstraps IAM — invoke() skips role checks in the app
// surface, so every mutation re-reads the caller's workspace role from
// Postgres before invoking. Two gates because the eval.* contracts split
// their defaultRoles.workspace: reads allow Owner/Member/Viewer, mutations
// allow only Owner/Member.
// ---------------------------------------------------------------------------

async function workspaceRole(workspaceId: string, userId: string): Promise<string> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  return (rows[0]?.role ?? "").toLowerCase();
}

async function assertWorkspaceWriter(
  workspaceId: string,
  userId: string,
): Promise<"ok" | "denied"> {
  const role = await workspaceRole(workspaceId, userId);
  return ["owner", "member"].includes(role) ? "ok" : "denied";
}

async function assertWorkspaceReader(
  workspaceId: string,
  userId: string,
): Promise<"ok" | "denied"> {
  const role = await workspaceRole(workspaceId, userId);
  return ["owner", "member", "viewer"].includes(role) ? "ok" : "denied";
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
  .optional();

const CreateDatasetSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1, "Name is required"),
  slug: SlugSchema,
  description: z.string().optional(),
});

const CreateTraceDatasetSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1, "Name is required"),
  slug: SlugSchema,
  description: z.string().optional(),
  capabilityName: z.string().optional(),
  sinceHours: z.number().int().min(1).max(24 * 90),
  limit: z.number().int().min(1).max(500),
});

const AddDatasetItemSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  datasetPublicId: z.string().min(1),
  input: z.string().min(1, "Input is required"),
  expectedOutput: z.string().optional(),
});

const GetDatasetSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  datasetPublicId: z.string().min(1),
  cursor: z.string().optional(),
});

const StartEvalRunSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  datasetPublicId: z.string().min(1),
  target: evalTargetSchema,
  judgeModel: z.string().min(1).optional(),
  name: z.string().optional(),
  passThreshold: z.number().min(0).max(1),
  maxItems: z.number().int().min(1).max(500).optional(),
});

const GetEvalRunStatusSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  runPublicId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// createDatasetAction — eval.dataset.create (manual dataset creation)
// ---------------------------------------------------------------------------

export async function createDatasetAction(
  input: z.input<typeof CreateDatasetSchema>,
): Promise<CreateDatasetResult> {
  const session = await getSessionOrRedirect();

  const parsed = CreateDatasetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, name, slug, description } = parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceWriter(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to create datasets." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      // create_dataset exposes surfaces ["api","mcp","cli"] — passing a
      // surface opt from the app would throw surface_denied; omit it.
      const out = (await invoke(
        "create_dataset",
        {
          name,
          ...(slug ? { slug } : {}),
          ...(description ? { description } : {}),
        },
        ctx,
      )) as EvalDatasetCreateOutput;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/evals`);
      return { ok: true, datasetId: out.datasetId, publicId: out.publicId, slug: out.slug };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id },
        "evals: createDatasetAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to create dataset." };
    }
  });
}

// ---------------------------------------------------------------------------
// createTraceDatasetAction — eval.dataset.from_traces (trace-derived dataset)
// ---------------------------------------------------------------------------

export async function createTraceDatasetAction(
  input: z.input<typeof CreateTraceDatasetSchema>,
): Promise<CreateTraceDatasetResult> {
  const session = await getSessionOrRedirect();

  const parsed = CreateTraceDatasetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, name, slug, description, capabilityName, sinceHours, limit } =
    parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceWriter(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to create datasets." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "create_trace_dataset",
        {
          name,
          ...(slug ? { slug } : {}),
          ...(description ? { description } : {}),
          ...(capabilityName ? { capabilityName } : {}),
          sinceHours,
          limit,
        },
        ctx,
      )) as EvalDatasetFromTracesOutput;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/evals`);
      return {
        ok: true,
        datasetId: out.datasetId,
        publicId: out.publicId,
        slug: out.slug,
        itemCount: out.itemCount,
      };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id },
        "evals: createTraceDatasetAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to create dataset from traces." };
    }
  });
}

// ---------------------------------------------------------------------------
// addDatasetItemAction — eval.dataset_item.add (add one case to a dataset)
//
// The contract is batch-shaped (`items: [...]`); this action always sends a
// single-item batch since the UI adds one case at a time.
// ---------------------------------------------------------------------------

export async function addDatasetItemAction(
  input: z.input<typeof AddDatasetItemSchema>,
): Promise<AddDatasetItemResult> {
  const session = await getSessionOrRedirect();

  const parsed = AddDatasetItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, datasetPublicId, input: itemInput, expectedOutput } =
    parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceWriter(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to add dataset items." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "add_dataset_item",
        {
          datasetPublicId,
          items: [
            {
              input: itemInput,
              ...(expectedOutput ? { expectedOutput } : {}),
            },
          ],
        },
        ctx,
      )) as EvalDatasetItemAddOutput;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/evals`);
      return { ok: true, datasetId: out.datasetId, added: out.added, itemCount: out.itemCount };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, datasetPublicId },
        "evals: addDatasetItemAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to add item." };
    }
  });
}

// ---------------------------------------------------------------------------
// getDatasetAction — eval.dataset.get (dataset detail + item page, read-only)
// ---------------------------------------------------------------------------

export async function getDatasetAction(
  input: z.input<typeof GetDatasetSchema>,
): Promise<GetDatasetResult> {
  const session = await getSessionOrRedirect();

  const parsed = GetDatasetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, datasetPublicId, cursor } = parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceReader(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to view this dataset." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "get_dataset",
        { datasetPublicId, limit: 50, ...(cursor ? { cursor } : {}) },
        ctx,
      )) as EvalDatasetGetOutput;

      return { ok: true, dataset: out.dataset, items: out.items, nextCursor: out.nextCursor };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, datasetPublicId },
        "evals: getDatasetAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to load dataset." };
    }
  });
}

// ---------------------------------------------------------------------------
// startEvalRunAction — eval.run.start (launch a run; async, returns a handle)
// ---------------------------------------------------------------------------

export async function startEvalRunAction(
  input: z.input<typeof StartEvalRunSchema> & { target: EvalTarget },
): Promise<StartEvalRunResult> {
  const session = await getSessionOrRedirect();

  const parsed = StartEvalRunSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, datasetPublicId, target, judgeModel, name, passThreshold, maxItems } =
    parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceWriter(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to start an eval run." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "start_eval_run",
        {
          datasetPublicId,
          target,
          ...(judgeModel ? { judgeModel } : {}),
          ...(name ? { name } : {}),
          passThreshold,
          ...(maxItems != null ? { maxItems } : {}),
        },
        ctx,
      )) as EvalRunStartOutput;

      return { ok: true, runId: out.runId, itemCount: out.itemCount };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, datasetPublicId },
        "evals: startEvalRunAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to start eval run." };
    }
  });
}

// ---------------------------------------------------------------------------
// getEvalRunStatusAction — eval.run.status (cheap poll while a run is live)
// ---------------------------------------------------------------------------

export async function getEvalRunStatusAction(
  input: z.input<typeof GetEvalRunStatusSchema>,
): Promise<GetEvalRunStatusResult> {
  const session = await getSessionOrRedirect();

  const parsed = GetEvalRunStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, runPublicId } = parsed.data;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceReader(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to view this run." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const status = (await invoke(
        "get_eval_status",
        { runPublicId },
        ctx,
      )) as EvalRunStatusOutput;

      return { ok: true, status };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, runPublicId },
        "evals: getEvalRunStatusAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to load run status." };
    }
  });
}
