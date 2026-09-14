/**
 * agent-defaults-tabs-shared.ts — pure, boundary-agnostic helpers for the
 * Workspace → Settings → Agent Defaults sub-tabs.
 *
 * Deliberately has NO "use client" directive: the `?tab=` guard is called from
 * BOTH the Server Component page (page.tsx, to resolve `initialTab` from the
 * search param) AND the client tabs wrapper (agent-defaults-tabs.tsx). A guard
 * exported from a "use client" module becomes a client reference that throws
 * ("Attempted to call isAgentDefaultsTab() from the server …") when the page
 * calls it during RSC render — so the shared, single-source-of-truth type +
 * values + guard live here, importable safely from either side of the
 * server/client boundary.
 */

export type AgentDefaultsTab = "models" | "budget" | "prompts" | "memory";

const TAB_VALUES: AgentDefaultsTab[] = [
  "models",
  "budget",
  "prompts",
  "memory",
];

export function isAgentDefaultsTab(
  value: string | undefined,
): value is AgentDefaultsTab {
  return value !== undefined && (TAB_VALUES as string[]).includes(value);
}
