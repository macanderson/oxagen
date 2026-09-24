"use client";
// The agent key's namespace prefix (`org_ns.ws_ns`, ADR-024) for the workspace
// the Agents page lists. No read answers it directly, so the page takes it
// from a key it already holds: every key in a workspace starts with the same
// two namespaces, and a slug carries no dot. Register reads it to say the
// whole key a slug becomes, as the design does; it is null when the page holds
// no key (the empty state), and Register then names the ending alone.
import { createContext, type ReactNode, use } from "react";

const KeyPrefixContext = createContext<string | null>(null);

/** The prefix of the first recorded key, or null when no key is recorded. */
export function keyPrefixOf(keys: readonly (string | null)[]): string | null {
  for (const key of keys) {
    if (key === null) continue;
    const dot = key.lastIndexOf(".");
    if (dot > 0) return key.slice(0, dot);
  }
  return null;
}

export function AgentKeyPrefix({
  value,
  children,
}: {
  value: string | null;
  children: ReactNode;
}) {
  return <KeyPrefixContext value={value}>{children}</KeyPrefixContext>;
}

export function useAgentKeyPrefix(): string | null {
  return use(KeyPrefixContext);
}
