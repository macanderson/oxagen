// The agent avatar Spend draws beside an agent key (#4871): the slug's first
// two letters, as `AgentCard` draws them, with the harness the agent
// registered in the lower-left corner. Spend's rows carry the key and not the
// harness, so the page reads the agents once (`readAgentHarnessIndex`) and
// hands each surface the harnesses by key. A key the index does not hold
// draws the avatar with no badge, never a guessed one.
import { AgentAvatar } from "@/ui/agent-avatar";

/** Each agent's registered harness, by agent key (`org_ns.ws_ns.slug`). */
export type AgentHarnesses = Readonly<Record<string, string>>;

/** The harness `key` names in `harnesses`, or null for a key it does not hold. */
export function harnessIn(
  harnesses: AgentHarnesses,
  key: string | null | undefined,
): string | null {
  if (key === null || key === undefined) return null;
  return Object.hasOwn(harnesses, key) ? (harnesses[key] ?? null) : null;
}

export function AgentMark({
  agentKey,
  harness,
  size = 22,
}: {
  agentKey: string;
  /** The recorded identifier, or null where nothing names one. */
  harness: string | null;
  size?: number;
}) {
  const slug = agentKey.split(".").at(-1) ?? agentKey;
  return (
    <AgentAvatar
      value={null}
      initials={slug.slice(0, 2).toUpperCase()}
      harness={harness}
      size={size}
    />
  );
}
