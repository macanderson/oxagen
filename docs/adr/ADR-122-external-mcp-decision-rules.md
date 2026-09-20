# ADR-122: External MCP calls enter the decision-rules gate

Status: accepted
Date: 2026-09-19
Related: #3137, #3118, #3055

## Decision

External MCP transports keep their existing identity and consent checks. Before dispatch, they also enter the kernel's injected decision-rules gate under their canonical `mcp.<server>.<tool>` or `file-mcp.<server>.<tool>` identity. Decision rules accept exact external identities, a server's tool prefix, or either external namespace. Platform capability naming remains unchanged.

Deny rules stop transport execution. A require_approval rule needs a human decision for that invocation. Its proof binds the input, current rule document, tenant and user, expires after five minutes, and belongs to a unique tool-call ID. Concurrent calls cannot borrow another call's approval. After an approval wait the gate reloads current rules; a new deny still stops the call.

The materializer checks rules before consent, again after consent, and without another interactive wait after its final IAM refresh. Kill switches are checked immediately before transport. Each external decision emits the same kernel security-event shape as built-in admission, including the tool, tenant, user, outcome and refusal code.

External rule reads are uncached and fail closed when the workspace, rule document or required facts are unavailable. A broken external rule loader cannot silently remove the operator's control. This decision does not change the existing infrastructure-failure posture for built-in capabilities.

## Mandates and auto-approval

External tools have no trusted declaration of cost, measures or consequences and no mandate settlement contract. Agent-principal calls are refused, including principals resolved by IAM outside an agent-run context. A person acting under their own authority can proceed after current IAM, consent and decision rules allow the call. Human consent does not substitute for an agent mandate.

Auto-approval does not apply to external transports. A matching auto-approval clause cannot skip a require_approval decision. Authoring one receives `external_auto_approval_unsupported`, explaining the missing measures. The old `rule_not_gated` refusal is removed because deny and human-approval rules now govern the transport. Unregistered built-in capability identities remain refused separately.

A future external mandate path needs trusted declared measures, reservation and settlement semantics, and tests showing how unknown external outcomes affect the ledger. It cannot infer a zero cost from a missing declaration.
