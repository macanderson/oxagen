/**
 * page.tsx — Workspace → Studio → Sandboxes (list).
 *
 * Lists the workspace's durable sandbox sessions (`list_sandboxes`) and hosts
 * the "warm a sandbox" panel. Data loads server-side via resolveStudioScope +
 * listSandboxes; the client panel owns the template picker, start action, and
 * navigation to a session's detail page. Listing is a pure Postgres read and
 * works even when the durable driver is unconfigured — only warming/running
 * needs SANDBOX_ENABLED, which the client surfaces as a soft warning.
 */
import type { Metadata } from "next";
import { resolveStudioScope } from "@/lib/studio/scope";
import {
  listSandboxes,
  isSandboxUnavailable,
  type SandboxSummary,
} from "@/lib/studio/sandboxes";
import { SandboxesClient } from "./sandboxes-client";

export const metadata: Metadata = {
  title: "Sandboxes | Studio",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function StudioSandboxesPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveStudioScope(orgSlug, workspaceSlug);

  let sandboxes: SandboxSummary[] = [];
  let unavailable = false;
  try {
    sandboxes = await listSandboxes(ctx);
  } catch (e) {
    // Degrade gracefully but never silently: an empty list that's really a
    // broken read looks like "no sandboxes".
    unavailable = isSandboxUnavailable(e);
    console.error("list_sandboxes failed:", e);
    sandboxes = [];
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Sandboxes</h2>
        <p className="text-sm text-muted-foreground">
          Durable code sandboxes agents build in — warm one from a template,
          drive its terminal, and inspect its files.
        </p>
      </div>
      <SandboxesClient
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialSandboxes={sandboxes}
        canManage={canManage}
        unavailable={unavailable}
      />
    </div>
  );
}
