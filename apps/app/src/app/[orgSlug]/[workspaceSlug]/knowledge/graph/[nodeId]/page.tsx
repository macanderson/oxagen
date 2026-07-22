/**
 * page.tsx — Workspace → Knowledge → Node detail.
 *
 * The inspectable detail page a chat capability result (graph-node-card or
 * graph-node-list-card) deep-links to. Server-fetches the node
 * via graph.node.get inside the tenant scope and renders its full property set,
 * provenance, and metadata — so a record id referenced in chat is always one
 * click from its source of truth. Also renders:
 *   - Neighbors: the node's one-hop neighborhood (ontology.neighbors), streamed
 *     in its own <Suspense> boundary so a slow/large neighborhood never blocks
 *     the header/properties.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Network, ArrowLeft, ExternalLink } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { GraphNodeGetOutput } from "@oxagen/oxagen/contracts/graph.node.get";
import type { GraphNodeLabelsGetOutput } from "@oxagen/oxagen/contracts/graph.node_label.get";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";
import { Badge } from "@/components/ui/badge";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { LoadingState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { NodeNeighbors } from "./_sections/node-neighbors";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; nodeId: string }>;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString();
}

export default async function KnowledgeNodePage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, nodeId } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();
  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let node: GraphNodeGetOutput["node"] = null;
  let labels: string[] = [];
  try {
    const result = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      async () => {
        const nodeResult = (await invoke("get_node", { nodeId }, ctx, {
          surface: "agent",
        })) as GraphNodeGetOutput;

        // Neo4j multi-label set (distinct from the single domain `label`
        // property returned by get_node) — best-effort, never blocks the page.
        let labelsResult: GraphNodeLabelsGetOutput | null = null;
        if (nodeResult.node) {
          try {
            labelsResult = (await invoke("get_node_labels", { nodeId }, ctx, {
              surface: "agent",
            })) as GraphNodeLabelsGetOutput;
          } catch {
            labelsResult = null;
          }
        }

        return { nodeResult, labelsResult };
      },
    );
    node = result.nodeResult.node;
    labels = result.labelsResult?.labels ?? [];
  } catch {
    node = null;
  }

  const scope = { orgSlug, workspaceSlug };
  const backToGraph = workspace.knowledge.graph(scope);

  if (!node) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-8 text-center">
        <Network
          className="mx-auto size-6 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="mt-3 text-sm font-semibold">Node not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The node <span className="font-mono text-xs">{nodeId}</span> does not
          exist in this workspace, or you don&apos;t have access to it.
        </p>
        <Link
          href={backToGraph}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to graph
        </Link>
      </div>
    );
  }

  const properties = node.properties ? Object.entries(node.properties) : [];
  const createdAt = formatWhen(node.createdAt);
  const updatedAt = formatWhen(node.updatedAt);

  return (
    <div className="space-y-5">
      <Link
        href={backToGraph}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Knowledge graph
      </Link>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-start gap-3 border-b border-border/60 px-6 py-4">
          <div className="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-2">
            <Network className="size-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">
              {node.displayName}
            </h1>
            {node.description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {node.description}
              </p>
            ) : null}
          </div>
          <Badge variant="outline" className="shrink-0">
            {node.label}
          </Badge>
        </div>

        <div className="grid gap-6 px-6 py-5 md:grid-cols-2">
          {/* Properties */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Properties
            </h2>
            {properties.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No properties recorded.
              </p>
            ) : (
              <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,auto)_1fr]">
                {properties.map(([k, v]) => {
                  const str = typeof v === "string" ? v : JSON.stringify(v);
                  return (
                    <div key={k} className="contents">
                      <dt className="text-xs font-medium text-muted-foreground">
                        {k}
                      </dt>
                      <dd className="min-w-0 break-words text-sm">
                        {typeof v === "string" && isHttpUrl(v) ? (
                          <a
                            href={v}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-primary hover:underline"
                          >
                            {str}
                            <ExternalLink
                              className="size-3 opacity-70"
                              aria-hidden="true"
                            />
                          </a>
                        ) : (
                          str
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>

          {/* Metadata / provenance */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Metadata
            </h2>
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,auto)_1fr]">
              <dt className="text-xs font-medium text-muted-foreground">
                Node ID
              </dt>
              {/* Citation rule: the raw id is never the primary identifier —
                  it only ever appears here, inside a CopyableId. */}
              <dd className="min-w-0">
                <CopyableId value={node.nodeId} label="ID" max={40} />
              </dd>
              <dt className="text-xs font-medium text-muted-foreground">
                Label
              </dt>
              <dd className="text-sm">{node.label}</dd>
              {labels.length > 0 ? (
                <>
                  <dt className="text-xs font-medium text-muted-foreground">
                    Labels
                  </dt>
                  <dd className="flex flex-wrap gap-1">
                    {labels.map((label) => (
                      <Badge key={label} variant="outline" size="sm">
                        {label}
                      </Badge>
                    ))}
                  </dd>
                </>
              ) : null}
              {createdAt ? (
                <>
                  <dt className="text-xs font-medium text-muted-foreground">
                    Created
                  </dt>
                  <dd className="text-sm">{createdAt}</dd>
                </>
              ) : null}
              {updatedAt ? (
                <>
                  <dt className="text-xs font-medium text-muted-foreground">
                    Updated
                  </dt>
                  <dd className="text-sm">{updatedAt}</dd>
                </>
              ) : null}
            </dl>
          </section>
        </div>
      </div>

      {/* Neighbors — the node's one-hop neighborhood. Its own Suspense
          boundary so a slow/large neighborhood never blocks the header and
          properties above from rendering. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card px-6 py-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Neighbors
        </h2>
        <Suspense fallback={<LoadingState variant="detail" />}>
          <NodeNeighbors
            orgId={org.id}
            workspaceId={ws.id}
            userId={session.user.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            nodeId={nodeId}
          />
        </Suspense>
      </div>
    </div>
  );
}
