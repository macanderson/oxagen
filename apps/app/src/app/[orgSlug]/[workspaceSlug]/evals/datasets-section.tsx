/**
 * datasets-section.tsx — Async server component that fetches the workspace's
 * eval datasets and renders DatasetsClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx so the static header is
 * shown immediately while this component streams in. Never throws from RSC —
 * a handler failure renders the client component with an empty dataset list
 * (its own empty state takes over).
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { EvalDatasetListOutput } from "@oxagen/oxagen/contracts/eval.dataset.list";
import { DatasetsClient } from "./datasets-client";

interface DatasetsSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function DatasetsSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: DatasetsSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let datasets: EvalDatasetListOutput["datasets"] = [];
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      // list_datasets exposes surfaces ["api","mcp","cli"] — passing a surface
      // opt from the app would throw surface_denied; omit so no allowlist runs.
      invoke("list_datasets", {}, ctx),
    )) as EvalDatasetListOutput;
    datasets = result.datasets;
  } catch (e) {
    console.error("eval.dataset.list failed:", e);
    // Render empty state on failure — never throw from RSC.
  }

  return <DatasetsClient datasets={datasets} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />;
}
