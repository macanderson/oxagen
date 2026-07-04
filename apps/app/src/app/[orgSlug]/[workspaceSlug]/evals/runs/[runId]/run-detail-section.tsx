/**
 * run-detail-section.tsx — Async server component that fetches one eval run
 * (summary + per-item results) and renders RunDetailClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx. Never throws from RSC —
 * a handler failure (including "run not found") renders the client
 * component's empty state instead of a 500.
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { EvalRunGetOutput } from "@oxagen/oxagen/contracts/eval.run.get";
import { RunDetailClient } from "./run-detail-client";

interface RunDetailSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  runPublicId: string;
}

export async function RunDetailSection({
  orgId,
  workspaceId,
  userId,
  runPublicId,
}: RunDetailSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let run: EvalRunGetOutput | null = null;
  try {
    run = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke("eval.run.get", { runPublicId }, ctx, { surface: "agent" }),
    )) as EvalRunGetOutput;
  } catch (e) {
    console.error("eval.run.get failed:", e);
    // Render empty state on failure — never throw from RSC.
  }

  return <RunDetailClient run={run?.run ?? null} results={run?.results ?? []} />;
}
