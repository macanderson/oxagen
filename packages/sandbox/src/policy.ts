import type { SandboxLanguage, SandboxRequest } from "./types";

export interface SandboxPolicy {
  allowedLanguages: readonly SandboxLanguage[];
  maxTimeoutMs: number;
  maxMemoryMb: number;
  allowNetwork: boolean;
}

// Conservative defaults. Workspace-level overrides flow in through the
// agent runtime's policy resolver, not from the model.
export const DEFAULT_POLICY: SandboxPolicy = {
  allowedLanguages: ["node", "python", "shell"],
  maxTimeoutMs: 30_000,
  maxMemoryMb: 512,
  allowNetwork: false,
};

export class SandboxPolicyError extends Error {
  // Stable, message-independent code so the capability layer can duck-type this
  // low-level infra error and re-surface it as a structured, user-visible
  // capability error (→ 400 invalid_input) instead of a leaked 500 — mirroring
  // how the sibling sandbox handlers carry a stable `code`. See the mapping in
  // packages/agent/src/handlers/agent.code.execute.ts.
  readonly code = "sandbox_policy_violation" as const;
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

// Clamp request fields to the policy ceiling and reject any request that
// crosses a hard boundary (language denylist, network when disallowed).
export function applyPolicy(
  req: SandboxRequest,
  p: SandboxPolicy,
): SandboxRequest {
  if (!p.allowedLanguages.includes(req.language)) {
    throw new SandboxPolicyError(
      `language ${req.language} not allowed by policy`,
    );
  }
  if (req.network === "allow" && !p.allowNetwork) {
    throw new SandboxPolicyError("network access not allowed by policy");
  }
  return {
    ...req,
    timeoutMs: Math.min(req.timeoutMs, p.maxTimeoutMs),
    memoryMb: Math.min(req.memoryMb, p.maxMemoryMb),
  };
}
