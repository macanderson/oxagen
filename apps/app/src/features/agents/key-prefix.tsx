"use client";
// The agent key's namespace prefix (`org_ns.ws_ns`, ADR-024), handed from the
// Agents page to Register, which reads it to say the whole key a slug becomes,
// as the design does. The page computes it with keyPrefixOf (./key-prefix-of);
// it is null when the page holds no key (the empty state), and Register then
// names the ending alone.
import { createContext, type ReactNode, use } from "react";

const KeyPrefixContext = createContext<string | null>(null);

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
