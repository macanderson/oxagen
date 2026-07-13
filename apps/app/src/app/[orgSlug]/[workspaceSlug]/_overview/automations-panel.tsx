/**
 * automations-panel.tsx — Overview HUD → Automations data panel.
 *
 * Up to 5 automations via automation.list (mirrors the invoke() shape used by
 * apps/app/src/lib/automations/automations.ts, the existing automations-section
 * consumer), each with a status dot and trigger-type label. Count chips
 * summarize active vs paused (and any other status) across the full list.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";
import Link from "next/link";
import { Zap } from "lucide-react";
import { Card, CardHeader, CardTitle, CardPanel } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { workspace } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";

interface AutomationsPanelProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const MAX_ROWS = 5;

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "error"> =
  {
    active: "success",
    enabled: "success",
    paused: "warning",
    disabled: "neutral",
    error: "error",
    failed: "error",
  };

export async function AutomationsPanel({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: AutomationsPanelProps) {
  const ctx = { orgSlug, workspaceSlug };
  const automationsHref = workspace.automations.root(ctx);

  let automations: AutomationListOutput = [];
  let failed = false;
  try {
    automations = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_automations",
        { workspace_id: workspaceId },
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
    )) as AutomationListOutput;
  } catch (e) {
    console.error("list_automations failed:", e);
    failed = true;
  }

  const statusCounts = new Map<string, number>();
  for (const a of automations) {
    statusCounts.set(a.status, (statusCounts.get(a.status) ?? 0) + 1);
  }

  const visible = automations.slice(0, MAX_ROWS);

  return (
    <div data-testid="overview-automations-panel">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Automations</CardTitle>
          <Link
            href={automationsHref}
            className="text-sm font-medium text-primary hover:underline"
          >
            View all →
          </Link>
        </CardHeader>
        <CardPanel className="pt-4">
          {failed ? (
            <ErrorState
              title="Automations unavailable"
              description="Could not load workspace automations."
            />
          ) : automations.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No automations yet"
              description="Create an automation to run agents on a trigger or schedule."
              action={
                <Link
                  href={automationsHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Create an automation →
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                {[...statusCounts.entries()].map(([status, count]) => (
                  <div key={status} className="flex items-baseline gap-1.5">
                    <dd className="font-semibold tabular-nums text-foreground">
                      {count}
                    </dd>
                    <dt className="text-xs text-muted-foreground">{status}</dt>
                  </div>
                ))}
              </dl>
              <ul className="flex flex-col divide-y divide-border">
                {visible.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={workspace.automations.automation(ctx, a.id)}
                      className="-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/60"
                    >
                      <span className="min-w-0 truncate text-foreground">
                        {a.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                        <span>{a.triggerType}</span>
                        <StatusDot
                          status={STATUS_TONE[a.status] ?? "neutral"}
                          size="sm"
                          label={a.status}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
