/**
 * Org workspaces home — lists every workspace in the org as a card.
 *
 * Fixes the broken org-mode "Workspaces" nav item, which used to point at the
 * org root (`/{orgSlug}`). That page immediately redirects into the first
 * workspace's Ask surface, so opening it from the governance surface flashed an
 * error and dumped the user on the Ask page. This gives that nav item a real
 * destination: a picker where each card shows the workspace avatar + name and
 * links into the workspace.
 */

import { eq } from "drizzle-orm";
import { Plus } from "lucide-react";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { EntityAvatar } from "@/components/avatar/entity-avatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { workspace as workspaceRoutes } from "@/lib/routes";
import Link from "next/link";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

interface WorkspaceCardData {
  publicId: string;
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export default async function WorkspacesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  const viewerUserId = session?.user?.id ?? "";

  // IDOR guard: assert membership before reading any org-scoped data.
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
  }

  const workspaces = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            publicId: schema.workspaces.publicId,
            slug: schema.workspaces.slug,
            name: schema.workspaces.name,
            avatarUrl: schema.workspaces.avatarUrl,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, org.id))
          .orderBy(schema.workspaces.createdAt),
      ),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workspaces"
        description={`Open a workspace in ${org.name} or create a new one.`}
        actions={
          <Button
            render={<Link href={`/${orgSlug}/new-workspace`} />}
            variant="gradient"
            size="sm"
            startIcon={<Plus className="h-4 w-4" aria-hidden="true" />}
          >
            New workspace
          </Button>
        }
      />

      {workspaces.length === 0 ? (
        <EmptyState orgSlug={orgSlug} />
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <li key={ws.publicId}>
              <WorkspaceCard orgSlug={orgSlug} workspace={ws} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkspaceCard({
  orgSlug,
  workspace,
}: {
  orgSlug: string;
  workspace: WorkspaceCardData;
}) {
  // Link straight to the workspace's Sessions surface — the chat front door.
  // Linking to the workspace root ({org}/{ws}) lands on the Overview instead;
  // going direct to Sessions preserves the "open a workspace → start chatting"
  // intent of the picker.
  const href = workspaceRoutes.sessions({
    orgSlug,
    workspaceSlug: workspace.slug,
  });

  return (
    <Card
      interactive
      className="group relative h-full transition-colors hover:border-primary/50"
    >
      <Link
        href={href}
        className="flex h-full items-center gap-4 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`Open workspace ${workspace.name}`}
      >
        <EntityAvatar
          value={workspace.avatarUrl}
          name={workspace.name}
          shape="square"
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-foreground">
            {workspace.name}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            /{workspace.slug}
          </p>
        </div>
      </Link>
    </Card>
  );
}

function EmptyState({ orgSlug }: { orgSlug: string }) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="text-base font-medium text-foreground">No workspaces yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Workspaces scope the knowledge graph, data, and agents. Create your
        first one to get started.
      </p>
      <Button
        render={<Link href={`/${orgSlug}/new-workspace`} />}
        variant="gradient"
        size="sm"
        className="mt-2"
        startIcon={<Plus className="h-4 w-4" aria-hidden="true" />}
      >
        New workspace
      </Button>
    </div>
  );
}
