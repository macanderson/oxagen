/**
 * page.tsx — Workspace → Workbench → Sandboxes → [sessionId] (detail).
 *
 * The terminal + file-browser surface for one durable sandbox. Resolves the
 * session summary from list_sandboxes (the Postgres source of truth) so the
 * header shows real status/image, then hands off to the client which owns the
 * interactive terminal (run_sandbox_command) and the file inspector
 * (agent.sandbox_file.*). 404s when the id doesn't belong to this workspace —
 * list_sandboxes is workspace-scoped, so an unknown id is genuinely not here.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { listSandboxes, type SandboxSummary } from "@/lib/workbench/sandboxes";
import { SandboxDetailClient } from "./sandbox-detail-client";

export const metadata: Metadata = {
  title: "Sandbox | Workbench",
};

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    sessionId: string;
  }>;
}

export default async function WorkbenchSandboxDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, sessionId } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(orgSlug, workspaceSlug);

  let sandboxes: SandboxSummary[] = [];
  try {
    sandboxes = await listSandboxes(ctx, { limit: 100 });
  } catch (e) {
    console.error("list_sandboxes failed:", e);
    sandboxes = [];
  }

  const summary = sandboxes.find((s) => s.sessionId === sessionId);
  if (!summary) {
    notFound();
  }

  return (
    <SandboxDetailClient
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      sessionId={sessionId}
      summary={summary}
      canManage={canManage}
    />
  );
}
