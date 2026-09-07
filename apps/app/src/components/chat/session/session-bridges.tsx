"use client";
/**
 * session-bridges.tsx — transitional adapters that present the LEGACY state
 * interfaces backed by the unified session store (chat_ux_v2).
 *
 * While the overhaul lands in phases, the flag-on tree keeps rendering the
 * existing composer/picker components — but their state must come from the
 * ONE store so the run payload, the SessionSettings surface, and the header
 * all agree. These bridges adapt `useChatSession()` to:
 *
 *   1. the `ChatSelectionStore` interface (the agent selection), consumed by
 *      `useComposerSelectionState()`;
 *   2. the `[ComposerModelState, setState]` tuple (model/tier/effort/budget/
 *      generate), consumed by the composer.
 *
 * Both return null/fall back when no ChatSessionProvider wraps the tree
 * (flag off), leaving legacy behavior byte-identical. Delete this file with
 * the flag once the legacy components are gone.
 */
import * as React from "react";
import type {
  AgentSelectionApply,
  ChatSelectionStore,
} from "../agent-picker/chat-selection-context";
import {
  applyWorkspaceBudgetGovernance,
  type ComposerModelState,
  type WorkspaceBudgetGovernance,
} from "../model-state";
import { useChatSessionContext } from "./session-store";
import type { ChatSessionState } from "./session-state";

// ---------------------------------------------------------------------------
// Bridge 1 — ChatSelectionStore (the agent selection)
// ---------------------------------------------------------------------------

/**
 * The unified store presented as the legacy `ChatSelectionStore`, or null
 * when no session provider is mounted.
 *
 * There is no lock here. The only lock the composer chip ever honoured was the
 * CODE lock — a coding target claimed on the first code turn — and it left with
 * the runtime (ADR-041). `agentId` is now a per-turn parameter of the stream
 * route, so the chip stays a live control for the whole conversation; the
 * read-only agent affordance that survives is the v2 session-settings AgentRow,
 * driven by `locks.agent` (server truth: `hasMessages`).
 */
export function useSessionSelectionBridge(): ChatSelectionStore | null {
  const session = useChatSessionContext();
  return React.useMemo<ChatSelectionStore | null>(() => {
    if (!session) return null;
    const { state, updateSession } = session;
    return {
      selectedAgentId: state.agentId,
      setSelectedAgentId: (id) => updateSession({ agentId: id }),
      applyAgentSelection: (sel: AgentSelectionApply) =>
        updateSession({ agentId: sel.agentId }),
    };
  }, [session]);
}

// ---------------------------------------------------------------------------
// Bridge 2 — ComposerModelState (model / tier / effort / budget / generate)
// ---------------------------------------------------------------------------

/** Project the session fields onto a ComposerModelState carrier. */
export function composeModelState(
  carrier: ComposerModelState,
  state: ChatSessionState,
  governance: WorkspaceBudgetGovernance | null,
): ComposerModelState {
  return applyWorkspaceBudgetGovernance(
    {
      ...carrier,
      tier: state.tier,
      model: state.model,
      effort: state.effort,
      budgetEnabled: state.budgetUsd !== null,
      budgetUsd: state.budgetUsd,
      // v2 semantics: a cap always pauses-and-asks at the ceiling.
      budgetMode: state.budgetUsd !== null ? "prompt" : carrier.budgetMode,
    },
    governance,
  );
}

/** Split a ComposerModelState back into a session patch. */
export function modelStateToSessionPatch(next: ComposerModelState): {
  tier: ChatSessionState["tier"];
  model: string | null;
  effort: ChatSessionState["effort"];
  budgetUsd: number | null;
} {
  return {
    tier: next.tier,
    model: next.model,
    effort: next.effort ?? "medium",
    budgetUsd: next.budgetEnabled ? next.budgetUsd : null,
  };
}

/**
 * Drop-in replacement for the composer's `useState<ComposerModelState>`:
 * with a session provider mounted, model/tier/effort/budget live in the
 * unified store (other carrier-only fields stay local); without one, this IS a
 * plain useState.
 */
export function useSessionModelState(
  initial: ComposerModelState,
  governance: WorkspaceBudgetGovernance | null,
): [
  ComposerModelState,
  React.Dispatch<React.SetStateAction<ComposerModelState>>,
] {
  const session = useChatSessionContext();
  // Carrier for the fields the session doesn't own (seeds, budget
  // mode/grace) AND the full fallback state when no provider exists.
  const [carrier, setCarrier] = React.useState<ComposerModelState>(initial);

  const composed = React.useMemo(
    () =>
      session ? composeModelState(carrier, session.state, governance) : carrier,
    [session, carrier, governance],
  );

  const composedRef = React.useRef(composed);
  React.useEffect(() => {
    composedRef.current = composed;
  }, [composed]);

  const updateSessionRef = React.useRef(session?.updateSession ?? null);
  React.useEffect(() => {
    updateSessionRef.current = session?.updateSession ?? null;
  }, [session]);

  const setComposed = React.useCallback<
    React.Dispatch<React.SetStateAction<ComposerModelState>>
  >((action) => {
    const update = updateSessionRef.current;
    if (!update) {
      setCarrier(action);
      return;
    }
    const next =
      typeof action === "function" ? action(composedRef.current) : action;
    // Sync the ref NOW, not in the post-render effect: two setModel calls in
    // the same handler must chain (the second reads the first's result), and
    // since modelStateToSessionPatch is a FULL replacement of the session
    // fields, a stale read here would silently clobber the first write.
    composedRef.current = next;
    update(modelStateToSessionPatch(next));
    // Keep the carrier in sync for the session-unowned fields.
    setCarrier(next);
  }, []);

  return [composed, setComposed];
}
