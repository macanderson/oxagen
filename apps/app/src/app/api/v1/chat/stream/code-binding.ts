// Conversation-level code binding — the "locked coding target" contract.
//
// A conversation's coding target (repo + environment + code agent) is chosen
// once, on its FIRST code-mode turn, persisted on chat.conversations
// (code_binding jsonb, migration 20260729120000_conversations_code_binding),
// and never changes for the conversation's lifetime — mirroring the CLI,
// where the repo is the launch cwd and is pinned for the whole session.
// Every later turn resolves the effective agent + code payload from the
// STORED binding, so neither a stale client nor a mid-conversation picker
// change can retarget the sandbox (the old failure mode: the warm sandbox
// was keyed per-connection, so "switching" repos silently reused the
// previous repo's clone while telling the model it was on the new one).
//
// This module is the PURE seam — parse the stored jsonb, resolve a turn,
// build the binding to claim — so it is unit-testable in isolation. The
// stream route owns all I/O: the conversation-row read, the one-time
// UPDATE … WHERE code_binding IS NULL claim, and emitting `warning` stream
// events for every overridden client value.

import { z } from "zod";

export const storedCodeBindingSchema = z.object({
  version: z.literal(1),
  /** The code agent (agt_… publicId) locked to the conversation. */
  agentId: z.string().min(1),
  connectionId: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1).nullable(),
  environmentId: z.string().min(1),
  environmentName: z.string().nullable(),
});

export type StoredCodeBinding = z.infer<typeof storedCodeBindingSchema>;

/** The slice of the request `code` payload (BodySchema.code) this seam needs. */
export interface RequestedCodePayload {
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  environmentId: string;
  environmentName: string | null;
  sandboxSessionId: string | null;
}

/**
 * Parse the raw `code_binding` jsonb column. Tolerant: a null column, an
 * unknown shape, or a future version parses to `null` (the conversation
 * behaves as unbound) rather than throwing — a corrupt binding must never
 * brick a conversation.
 */
export function parseStoredCodeBinding(
  raw: unknown,
): StoredCodeBinding | null {
  if (raw === null || raw === undefined) return null;
  const parsed = storedCodeBindingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Build the binding to claim from this turn's payload + bound agent. */
export function toStoredCodeBinding(
  code: RequestedCodePayload,
  agentId: string,
): StoredCodeBinding {
  return {
    version: 1,
    agentId,
    connectionId: code.connectionId,
    owner: code.owner,
    name: code.name,
    defaultBranch: code.defaultBranch,
    environmentId: code.environmentId,
    environmentName: code.environmentName,
  };
}

export interface CodeBindingResolution {
  /** Agent for this turn — a stored binding's agent wins over the request. */
  agentId: string | null;
  /** Effective code payload — a stored binding wins over the request. */
  code: RequestedCodePayload | null;
  /** One note per client value the binding overrode (→ `warning` events). */
  warnings: string[];
}

function sameRepo(a: RequestedCodePayload, b: StoredCodeBinding): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.owner === b.owner &&
    a.name === b.name
  );
}

/**
 * Resolve a turn's effective agent + code payload from the stored binding
 * and the client request. Pure. With no stored binding the request passes
 * through untouched (the claim happens later, once code mode is
 * authoritatively active). With a stored binding, the binding is the truth:
 * the client's `sandboxSessionId` warm-session hint is kept only when it
 * refers to the bound repo — a hint minted for a different repo must not
 * reconnect its sandbox.
 */
export function resolveCodeBinding(args: {
  stored: StoredCodeBinding | null;
  requestedAgentId: string | null;
  requestedCode: RequestedCodePayload | null;
}): CodeBindingResolution {
  const { stored, requestedAgentId, requestedCode } = args;
  if (!stored) {
    return { agentId: requestedAgentId, code: requestedCode, warnings: [] };
  }

  const warnings: string[] = [];
  if (requestedAgentId && requestedAgentId !== stored.agentId) {
    warnings.push(
      "This conversation is locked to the agent it started with — the requested agent was ignored. Start a new conversation to use a different agent.",
    );
  }
  if (requestedCode && !sameRepo(requestedCode, stored)) {
    warnings.push(
      `This conversation is locked to ${stored.owner}/${stored.name} — the requested repository was ignored. Start a new conversation to work on a different repository.`,
    );
  }
  if (requestedCode && requestedCode.environmentId !== stored.environmentId) {
    warnings.push(
      "This conversation is locked to the environment it started with — the requested environment was ignored.",
    );
  }

  return {
    agentId: stored.agentId,
    code: {
      connectionId: stored.connectionId,
      owner: stored.owner,
      name: stored.name,
      defaultBranch: stored.defaultBranch,
      environmentId: stored.environmentId,
      environmentName: stored.environmentName,
      sandboxSessionId:
        requestedCode && sameRepo(requestedCode, stored)
          ? requestedCode.sandboxSessionId
          : null,
    },
    warnings,
  };
}
