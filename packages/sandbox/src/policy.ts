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
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

// Clamp request fields to the policy ceiling and reject any request that
// crosses a hard boundary (language denylist, network when disallowed).
export function applyPolicy(req: SandboxRequest, p: SandboxPolicy): SandboxRequest {
  if (!p.allowedLanguages.includes(req.language)) {
    throw new SandboxPolicyError(`language ${req.language} not allowed by policy`);
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
