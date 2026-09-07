# Shared codebase notes

- Durable `RunSpecV1` does not capture the enqueuing principal; any lifecycle or delegated execution feature that claims IAM equivalence must introduce a versioned principal reference and re-resolve current grants at claim time.
- `CapabilityContext.surface` includes `runner`, while public `CapabilitySurface` does not. Internal lifecycle eligibility should be orthogonal contract metadata, not a spoofed public surface.
- `chat_ux_v2` (apps/app/src/lib/flags.ts) defaults OFF (`NEXT_PUBLIC_CHAT_UX_V2` unset). e2e and prod therefore exercise the LEGACY chat surface: no `ChatSessionProvider`, `useSessionSelectionBridge()` returns null, and `useComposerSelectionState()` falls through to `ChatSelectionProvider`. Anything asserted about the v2 session store is untested by e2e.
- Post-ADR-041 the chat `agentId` is a PER-TURN parameter of `/api/v1/chat/stream` (BodySchema: "this turn is BOUND to that agent"); there is no durable conversation-to-agent binding. `stream/code-binding.ts` is deleted. Do not reintroduce conversation-scoped agent locking.
- The composer's agent chip popover also hosts the workspace 'default assistant' star (a workspace preference, not conversation state), so disabling the chip strands an unrelated capability. Covered by `apps/app/e2e/chat-agent-picker.spec.ts`.
