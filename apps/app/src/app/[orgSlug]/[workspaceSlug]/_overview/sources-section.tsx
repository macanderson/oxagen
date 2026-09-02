/**
 * sources-section.tsx — Overview → Connected sources health tile.
 *
 * Up to 6 connections via connection.list, each with a healthy/degraded/errored
 * status chip. Uses the shared <StatusDot> primitive (packages/ui) rather than
 * hand-rolling a health dot, so every health indicator in the app reskins from
 * one place.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import Link from "next/link";
import { Plug } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import { workspace } from "@/lib/routes";
import { Tile, EmptyState, ErrorState } from "../_shared/components";

interface SourcesTileProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const MAX_ROWS = 6;

const HEALTH_TONE: Record<string, "success" | "warning" | "error"> = {
  healthy: "success",
  degraded: "warning",
  errored: "error",
};

export async function SourcesTile({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: SourcesTileProps) {
  const reposHref = workspace.knowledge.sources({ orgSlug, workspaceSlug });

  let connections: ConnectionListOutput["connections"] = [];
  let failed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_connections",
        {},
        {
          orgId,
          workspaceId,
          userId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        },
        { surface: "agent" },
      ),
    )) as ConnectionListOutput;
    connections = result.connections;
  } catch (e) {
    console.error("list_connections failed:", e);
    failed = true;
  }

  const visible = connections.slice(0, MAX_ROWS);
  const footer = (
    <Link
      href={reposHref}
      className="text-sm font-medium text-primary hover:underline"
    >
      View sources →
    </Link>
  );

  return (
    <div data-testid="overview-sources-tile">
      <Tile title="Source health" footer={footer}>
        {failed ? (
          <ErrorState
            title="Source health unavailable"
            description="Could not load connected source status."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No sources connected yet"
            description="Connect a data source to start ingesting knowledge."
            action={
              <Link
                href={reposHref}
                className="text-sm font-medium text-primary hover:underline"
              >
                Connect a source →
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {visible.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">
                  {c.displayName}
                </span>
                <StatusDot
                  status={HEALTH_TONE[c.healthStatus] ?? "neutral"}
                  size="sm"
                  label={c.healthStatus}
                  className="shrink-0 text-xs text-muted-foreground"
                />
              </li>
            ))}
          </ul>
        )}
      </Tile>
    </div>
  );
}
