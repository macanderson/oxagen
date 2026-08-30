/**
 * memories-panel.tsx — Overview HUD → Memory captured data panel.
 *
 * Up to 50 most-recent AgentMemory records via agent.memory.list (default
 * sort createdAt desc), same register imports as
 * knowledge/memory/memories-section.tsx (agent.memory.list is an agent.*
 * capability bound by @oxagen/agent/register, not the foundation register).
 * Headline stat is memories captured in the last 7 days vs the prior 7 days,
 * shown via DeltaChip. Rows show the lesson (truncated), memoryClass, and
 * time-ago — never a raw UUID (id/publicId/nodeRef are never rendered).
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type {
  AgentMemoryListOutput,
  AgentMemoryRecord,
} from "@oxagen/oxagen/contracts/agent.memory.list";
import Link from "next/link";
import { BrainCircuit } from "lucide-react";
import { Card, CardHeader, CardTitle, CardPanel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { workspace } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";
import { timeAgo } from "@/components/activity/format";
import { DeltaChip } from "./hud/delta-chip";

interface MemoriesPanelProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const SAMPLE_LIMIT = 50;
const RECENT_ROWS = 5;
const LESSON_TRUNCATE = 140;

const DAY_MS = 24 * 60 * 60 * 1000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Count memories captured in the last 7 days vs the prior 7 days, over the
 * createdAt-desc sample the panel fetched. `Date.now()` lives here (a plain
 * helper) rather than the component body — calling an impure function during
 * render is rejected by the React purity lint rule.
 *
 * NOTE the sample is bounded at SAMPLE_LIMIT. When it comes back full, both
 * counts are floors and the prior week may be entirely off the end of the list,
 * so the caller must not present the comparison as a real delta.
 */
function weeklyDelta(memories: AgentMemoryRecord[]): {
  last7d: number;
  prior7d: number;
} {
  const now = Date.now();
  let last7d = 0;
  let prior7d = 0;
  for (const m of memories) {
    const age = now - new Date(m.createdAt).getTime();
    if (age < 0) continue;
    if (age <= 7 * DAY_MS) last7d += 1;
    else if (age <= 14 * DAY_MS) prior7d += 1;
  }
  return { last7d, prior7d };
}

export async function MemoriesPanel({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: MemoriesPanelProps) {
  const ctx = { orgSlug, workspaceSlug };
  const memoryHref = workspace.knowledge.memory(ctx);

  let memories: AgentMemoryRecord[] = [];
  let failed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_memories",
        { limit: SAMPLE_LIMIT },
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
    )) as AgentMemoryListOutput;
    memories = result.memories;
  } catch (e) {
    console.error("list_memories failed:", e);
    failed = true;
  }

  const { last7d, prior7d } = weeklyDelta(memories);
  const recent = memories.slice(0, RECENT_ROWS);
  // A full sample means older memories were cut off, so `prior7d` is not a real
  // prior week — often a structural 0, which the chip would render as a
  // permanent "new". Show the count as a floor and drop the comparison.
  const sampleSaturated = memories.length >= SAMPLE_LIMIT;

  return (
    <div data-testid="overview-memories-panel">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Memory captured</CardTitle>
          <Link
            href={memoryHref}
            className="text-sm font-medium text-primary hover:underline"
          >
            Review memory →
          </Link>
        </CardHeader>
        <CardPanel className="pt-4">
          {failed ? (
            <ErrorState
              title="Memory unavailable"
              description="Could not load captured memory."
            />
          ) : memories.length === 0 ? (
            <EmptyState
              icon={BrainCircuit}
              title="No memories captured yet"
              description="Memory accumulates as agents learn from runs and feedback."
              action={
                <Link
                  href={memoryHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Open memory →
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                  {sampleSaturated ? `${last7d}+` : last7d}
                </span>
                <span className="text-xs text-muted-foreground">
                  memories · last 7 days
                </span>
                {sampleSaturated ? null : (
                  <DeltaChip
                    current={last7d}
                    previous={prior7d}
                    goodDirection="up"
                    label="vs last week"
                  />
                )}
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {recent.map((m) => (
                  <li key={m.id} className="flex flex-col gap-1 py-2 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-foreground">
                        {truncate(m.lesson, LESSON_TRUNCATE)}
                      </span>
                      <Badge variant="muted" size="sm" className="shrink-0">
                        {m.memoryClass}
                      </Badge>
                    </div>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{timeAgo(m.createdAt)}</span>
                      {m.citationCount > 0 ? (
                        <span>
                          · {m.citationCount} citation
                          {m.citationCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </span>
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
