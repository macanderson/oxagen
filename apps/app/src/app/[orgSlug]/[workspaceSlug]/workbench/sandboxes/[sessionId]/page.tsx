/**
 * page.tsx — Workspace → Workbench → Sandboxes → [sessionId] (detail).
 *
 * The terminal + file-browser surface for one durable sandbox. Resolves the
 * session summary from list_sandboxes (the Postgres source of truth) so the
 * header shows real status/image, then hands off to the client which owns the
 * interactive terminal (run_sandbox_command) and the file inspector
 * (agent.sandbox_file.*).
 *
 * The id is resolved by scanning the workspace's session list, so this 404s in
 * three cases that look identical to the visitor: the id belongs to another
 * workspace, the session list read failed (logged), or the workspace has more
 * than the `limit` sessions below and this one fell outside the page.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { logger } from "@oxagen/handlers/logger";
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

export default async function WorkbenchSandboxDetailPage({
  params,
}: PageProps) {
  const { orgSlug, workspaceSlug, sessionId } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );

  let sandboxes: SandboxSummary[] = [];
  try {
    sandboxes = await listSandboxes(ctx, { limit: 100 });
  } catch (e) {
    logger.error(
      { err: e, orgSlug, workspaceSlug, sessionId },
      "sandboxes: listSandboxes failed — the detail page will 404",
    );
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
