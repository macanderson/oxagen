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
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
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
  let loadFailed = false;
  try {
    run = (await runInTenantScope({ orgId, workspaceId }, () =>
      // get_eval_run exposes surfaces ["api","mcp","cli"] — passing a surface
      // opt from the app would throw surface_denied; omit so no allowlist runs.
      invoke("get_eval_run", { runPublicId }, ctx),
    )) as EvalRunGetOutput;
  } catch (e) {
    console.error("eval.run.get failed:", e);
    // A failed read (including "run not found") is an error, not empty data —
    // surface it rather than throwing from RSC or rendering a bare client.
    loadFailed = true;
  }

  if (loadFailed) {
    return (
      <ErrorState
        title="Couldn't load this run"
        description="This eval run could not be loaded. It may have been deleted, or something went wrong — reload the page to try again."
      />
    );
  }

  return (
    <RunDetailClient run={run?.run ?? null} results={run?.results ?? []} />
  );
}
