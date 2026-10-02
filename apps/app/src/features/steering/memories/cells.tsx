// The pieces the Memories table and the memory drawer both draw (the mockup's
// steering.js `memUses`, `memLast`, `memHarness`, `memAgentName` and
// `MEM_STATE`): the state badge, the uses, the last use, the harness, and the
// agent with its operator.
//
// A memory whose source reports no use reads "No signal" in both Uses and
// Last used, so a zero never reads as unused. A memory no harness holds names
// how it arrived instead: an agent's lesson, the code repository check, the
// local gateway, or a Markdown import.
import { useLocale, useTranslations } from "next-intl";
import type {
  MemoryHarness,
  WorkspaceMemory,
  WorkspaceMemoryState,
} from "@/data/contracts/steering";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Badge, type BadgeTone } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { formatCount } from "@/ui/money-format";

/** An agent the registry holds, by its key, as a memory row names it. */
export type MemoryAgent = {
  name: string;
  operator: string | null;
  harness: string | null;
};
export type MemoryAgents = Readonly<Record<string, MemoryAgent>>;

/** Claude Code's four memory types, which the Type filter offers. */
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

const isMemoryType = (value: string): value is MemoryType =>
  MEMORY_TYPES.some((type) => type === value);

const STATE_TONE: Record<WorkspaceMemoryState, BadgeTone> = {
  waiting: "quiet",
  in_pr: "approval",
  promoted: "allowed",
  dismissed: "quiet",
  retired: "quiet",
};

/** A second line under a cell's value, cut with an ellipsis and shown whole on hover. */
export const subLine =
  "mt-0.5 block max-w-[28ch] truncate text-sm text-muted-foreground";

/** The words for a memory's harness and type, from the tab's catalogue. */
export function useMemoryWords() {
  const t = useTranslations("steering.memories");
  return {
    harness: (harness: MemoryHarness) => t(`harness.${harness}`),
    /** The harness that holds the memory, or how it arrived when none does. */
    source: (memory: Pick<WorkspaceMemory, "harness" | "capture">) =>
      memory.harness === null
        ? t(`captures.${memory.capture}`)
        : t(`harness.${memory.harness}`),
    type: (type: string) => (isMemoryType(type) ? t(`types.${type}`) : type),
  };
}

export function MemoryStateBadge({ state }: { state: WorkspaceMemoryState }) {
  const t = useTranslations("steering.memories.states");
  return (
    <Badge tone={STATE_TONE[state]} data-memory-state={state}>
      {t(state)}
    </Badge>
  );
}

/** True when any of the memories has a use signal. */
export function hasSignal(memories: readonly WorkspaceMemory[]): boolean {
  return memories.some((memory) => memory.useSignal);
}

/** The uses, or No signal. */
export function UsesValue({
  uses,
  signal,
}: {
  uses: number;
  signal: boolean;
}) {
  const t = useTranslations("steering.memories");
  const locale = useLocale();
  return signal ? (
    <>{formatCount(uses, locale)}</>
  ) : (
    <span className="text-muted-foreground" data-no-signal="">
      {t("noSignal")}
    </span>
  );
}

/** The newest use as relative time, Never, or No signal. */
export function LastUsedValue({
  at,
  signal,
  readAt,
}: {
  at: string | null;
  signal: boolean;
  /** The instant the page read the memories, which "3 days ago" counts from. */
  readAt: string;
}) {
  const t = useTranslations("steering.memories");
  const format = useFormatter();
  if (!signal) {
    return <span className="text-muted-foreground">{t("noSignal")}</span>;
  }
  if (at === null) {
    return <span className="text-muted-foreground">{t("never")}</span>;
  }
  return <>{format.relativeTime(new Date(at), new Date(readAt))}</>;
}

/** The harness mark and name, or how the memory arrived when no harness holds it. */
export function HarnessValue({ memory }: { memory: WorkspaceMemory }) {
  const words = useMemoryWords();
  return (
    <span className="inline-flex items-center gap-1.5">
      <HarnessIcon harness={memory.harness} size={14} />
      <span className="truncate" data-truncate="">
        {words.source(memory)}
      </span>
    </span>
  );
}

/**
 * The agent that wrote the memory, with its avatar and its operator under it,
 * when the registry holds it; its key when the registry does not; and No
 * known agent when Oxagen could not tell.
 */
export function AgentValue({
  agent,
  agents,
}: {
  agent: string | null;
  agents: MemoryAgents;
}) {
  const t = useTranslations("steering.memories");
  if (agent === null) {
    return <span className="text-muted-foreground">{t("noAgent")}</span>;
  }
  const known = Object.hasOwn(agents, agent) ? agents[agent] : undefined;
  if (known === undefined) {
    return (
      <span className={`${mono} block max-w-[28ch] truncate`} data-truncate="">
        {agent}
      </span>
    );
  }
  const slug = agent.split(".").at(-1) ?? agent;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <AgentAvatar
        value={null}
        initials={slug.slice(0, 2).toUpperCase()}
        harness={known.harness}
        size={20}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate" data-truncate="">
          {known.name}
        </span>
        {known.operator === null ? null : (
          <span className={subLine} data-truncate="">
            {known.operator}
          </span>
        )}
      </span>
    </span>
  );
}

/** The repositories a memory is scoped to, without the host, or None. */
export function RepoValue({ repos }: { repos: readonly string[] | null }) {
  const t = useTranslations("steering.memories");
  if (repos === null || repos.length === 0) {
    return <span className="text-muted-foreground">{t("none")}</span>;
  }
  return (
    <span className={`${mono} block max-w-[24ch] truncate`} data-truncate="">
      {repos.map((repo) => repo.replace(/^[^/]+\//, "")).join(" ")}
    </span>
  );
}

/** The first sentence of a statement, which names a memory with no label. */
function firstSentence(statement: string): string {
  const [first] = statement.split(/(?<=[.?!])\s+/);
  return first ?? statement;
}

/** The memory's name: its label, or its statement's first sentence. */
export function memoryName(memory: WorkspaceMemory): string {
  return memory.label ?? firstSentence(memory.statement);
}

/** The line under the name: the summary, or the rest of the statement. */
export function memorySub(memory: WorkspaceMemory): string {
  if (memory.summary !== null) return memory.summary;
  if (memory.label !== null) return "";
  return memory.statement.slice(firstSentence(memory.statement).length).trim();
}
