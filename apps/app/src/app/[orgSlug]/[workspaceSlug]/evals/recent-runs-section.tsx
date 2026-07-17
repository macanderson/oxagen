/**
 * recent-runs-section.tsx — Async server component that fetches the workspace's
 * most recent eval runs and renders RecentRunsClient.
 *
 * Rendered inside its own <Suspense> boundary in page.tsx so it streams in
 * independently of the datasets section. Never throws from RSC — a handler
 * failure renders the client with an empty run list + zeroed totals (its own
 * empty state takes over). Mirrors datasets-section.tsx exactly.
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { RecentRunsClient } from "./recent-runs-client";

interface RecentRunsSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function RecentRunsSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: RecentRunsSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let runs: EvalRunListOutput["runs"] = [];
  let allTimeTotal = 0;
  let loadFailed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      // list_eval_runs exposes surfaces ["api","mcp","cli"] — passing a surface
      // opt from the app would throw surface_denied; omit so no allowlist runs.
      invoke(
        "list_eval_runs",
        { limit: 8, sortBy: "created", sortDir: "desc" },
        ctx,
      ),
    )) as EvalRunListOutput;
    runs = result.runs;
    allTimeTotal = result.allTimeTotal;
  } catch (e) {
    console.error("eval.run.list failed:", e);
    // A fetch failure is not "no runs yet" — surface it as an error (never
    // throw from RSC, which would blank the streamed header) rather than
    // masquerading the failure as the client's empty state.
    loadFailed = true;
  }

  if (loadFailed) {
    return (
      <ErrorState
        title="Couldn't load recent runs"
        description="Something went wrong loading your eval runs. Reload the page to try again."
      />
    );
  }

  return (
    <RecentRunsClient
      runs={runs}
      allTimeTotal={allTimeTotal}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
