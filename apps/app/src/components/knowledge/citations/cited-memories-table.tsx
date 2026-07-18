/**
 * cited-memories-table.tsx — generic ranked-memory table for the Citations
 * dashboard, used for both "Most cited memories" (topMemories) and "Least
 * useful memories" (leastUsefulMemories) — same row shape (CitedMemoryStat),
 * different data + framing copy, so one parameterized table avoids forking
 * the markup twice.
 *
 * Server-safe: the influence mini-bar is plain divs with proportional widths
 * computed at render time, no client JS required.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TruncatedText } from "@/components/ui/truncated-text";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import type { CitedMemoryStat } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import type { LucideIcon } from "lucide-react";

// Epistemic class → badge variant, same mapping as the "Grounded in" chat
// citation card (memory-card.tsx): FACT is most trustworthy (success), RULE
// is policy-enforced (warning), OBSERVATION is the lowest confidence rung
// (muted).
const CLASS_VARIANT: Record<
  string,
  "success" | "warning" | "muted" | "default"
> = {
  FACT: "success",
  RULE: "warning",
  OBSERVATION: "muted",
};

const INFLUENCE_SEGMENT_COLOR = {
  decisive: "bg-emerald-500",
  contributing: "bg-blue-500",
  considered: "bg-amber-500",
  ignored: "bg-zinc-300 dark:bg-zinc-600",
} as const;

function MemoryInfluenceBars({ memory }: { memory: CitedMemoryStat }) {
  const total =
    memory.decisiveCount +
    memory.contributingCount +
    memory.consideredCount +
    memory.ignoredCount;
  if (total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const segments = [
    { key: "decisive", count: memory.decisiveCount, label: "decisive" },
    {
      key: "contributing",
      count: memory.contributingCount,
      label: "contributing",
    },
    { key: "considered", count: memory.consideredCount, label: "considered" },
    { key: "ignored", count: memory.ignoredCount, label: "ignored" },
  ] as const;
  const summary = segments
    .filter((s) => s.count > 0)
    .map((s) => `${s.count} ${s.label}`)
    .join(", ");

  return (
    <div
      className="flex h-2 w-24 overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`Influence breakdown: ${summary}`}
    >
      {segments.map((s) =>
        s.count > 0 ? (
          <span
            key={s.key}
            className={INFLUENCE_SEGMENT_COLOR[s.key]}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

export interface CitedMemoriesTableProps {
  memories: CitedMemoryStat[];
  heading: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  memoryPageHref: string;
}

export function CitedMemoriesTable({
  memories,
  heading,
  icon: Icon,
  emptyTitle,
  emptyDescription,
  memoryPageHref,
}: CitedMemoriesTableProps) {
  return (
    <section
      aria-labelledby={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3
          id={`${heading.replace(/\s+/g, "-").toLowerCase()}-heading`}
          className="text-sm font-semibold text-foreground"
        >
          {heading}
        </h3>
      </div>
      {memories.length === 0 ? (
        <EmptyState
          icon={Icon}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <Table density="compact">
          <TableHeader>
            <TableRow>
              <TableHead>Memory</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Citations</TableHead>
              <TableHead>Influence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memories.map((memory) => (
              <TableRow key={memory.memoryId}>
                <TableCell className="max-w-[20rem]">
                  <Link href={memoryPageHref} className="hover:underline">
                    <TruncatedText
                      text={memory.lesson}
                      lines={2}
                      markdown={false}
                    />
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={CLASS_VARIANT[memory.memoryClass] ?? "default"}
                    className="uppercase"
                  >
                    {memory.memoryClass}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {memory.memoryKind}
                </TableCell>
                <TableCell className="tabular-nums">
                  {memory.citationCount.toLocaleString()}
                </TableCell>
                <TableCell>
                  <MemoryInfluenceBars memory={memory} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
