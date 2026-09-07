<!-- Re-homed from macanderson/cgp-website docs/design/tacho/approval-tokens.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho approval flow and capability tokens

- Status: draft design
- Date: 2026-08-31
- Parent: [overview.md](overview.md)
- Decision records: [ADR 0003](adr-0003-tacho-capability-tokens-biscuit.md)
  (Biscuit), [ADR 0004](adr-0004-tacho-policy-engine-cedar.md) (Cedar)

## 1. Standing grants vs elevation

**Standing grants** are what an agent may do without asking. They ship as a
signed, versioned **Cedar policy bundle**, synced to and cached by the local
collector, and evaluated *locally* — zero added latency for routine actions.

**Elevation** happens when the wrapper's pre-action check finds no standing
grant. The wrapper:

1. emits a chained `approval_request` event
   (`{ scope, resource, reason_text, requesting_span }`), then
2. synchronously calls the PDP (via the collector) with
   `{ agent identity, trust-score tier, canonical action (verb + resource),
   triggering span, recent-history digest }`.

## 2. Decision flow

```
wrapper ── approval_request ──► collector ──► PDP (Cedar)
                                               │
                       ┌───────────────────────┼───────────────────────┐
                       ▼                       ▼                       ▼
                     allow                   deny                  escalate
                       │                       │                       │
                       ▼                       ▼                       ▼
                Mint issues Biscuit    token_denied event      human-in-loop queue
                token_issued event     (policy_id, reason)     (Slack / dashboard,
                       │                                        requesting span +
                       ▼                                        agent history inline)
                wrapper verifies                                approver decision →
                offline, token_use,                             allow/deny as above;
                executes                                        approver_id recorded
```

The PDP evaluates the Cedar bundle with the agent's **trust tier** and request
context as Cedar context attributes. Outcomes:

- **allow** → the Mint issues a token (§3); a `token_issued` event chains the
  decision.
- **deny** → a chained `token_denied` event carrying the deciding `policy_id`
  and `reason_code`. A deny is itself evidence.
- **escalate** → the request enters the human-in-loop queue with the
  requesting span and the agent's recent history inline. The approver's
  identity and free-text reason become part of the decision event and the
  token's audit trail.

### Example Cedar policies

```cedar
// Standing grant: any agent in the fleet may read its own workspace.
permit (principal in Fleet::"flt_acme_support",
        action == Action::"file.read",
        resource in Workspace::"ws_support")
;

// Elevation, auto-approvable at tier T2+: refunds under $500.
permit (principal, action == Action::"tool:payments.refund", resource)
when  { context.trust_tier >= 2 && context.amount_usd <= 500 };

// Never auto-approve: production database writes always escalate.
forbid (principal, action == Action::"db.write",
        resource in Database::"prod")
unless { context.human_approved };
```

## 3. Token format: Biscuit v2

Chosen over JWT+DPoP and macaroons — rationale in
[ADR 0003](adr-0003-tacho-capability-tokens-biscuit.md). The properties
that matter here:

- **Offline verification.** The wrapper verifies against the Mint's published
  Ed25519 root public key — no callback, no shared secret in the agent
  process (macaroons require a verifier-side shared secret: disqualified).
- **First-class caveats/attenuation.** Scope, expiry, use limits, and
  resource patterns are datalog checks inside the token. An enterprise
  gateway can further *attenuate* a token offline (e.g. narrow
  `net.egress:*.github.com` to a single repo) without round-tripping to the
  Mint.
- **Proof-of-possession.** Each session generates an ephemeral keypair at
  `agent_start` (public key bound into the genesis event). The Mint adds a
  third-party block bound to that key, so a token replayed outside its
  session fails verification.

### Authority block facts

```
token_id("tok_01J6XS…")
agent("agnt_…")
session("sess_01J6XR…")
scope("tool:payments.refund", "resource:order/123")   // the exact action
issued_at(2026-08-31T12:00:04Z)
expires_at(2026-08-31T12:02:04Z)     // default 120 s; hard max 1 h
use_limit(1)                          // single-use for destructive verbs
approval_event("evt_01J6XS…")         // the approval_decision event
decision("policy:cedar/refunds-t2" | "approver:usr_…", "reason:auto_t2_under_500")
```

### Caveat catalog (initial)

| Caveat | Meaning |
| --- | --- |
| `check if time < expires_at` | Expiry (mandatory). |
| `check if scope matches requested action` | Exact-action binding (mandatory). |
| `check if session == current_session` | Session binding via PoP block (mandatory). |
| `check if use_count < use_limit` | Single/limited use, enforced against the collector's local nonce set. |
| `check if resource in <pattern>` | Attenuable resource narrowing. |
| `check if amount <= <n>` | Parameter bounds for financial verbs. |

## 4. Traceability chain

Four hash-chained hops from "money moved" back to "why it was allowed":

```
token_use ──► token_issued ──► approval_decision ──► approval_request ──► requesting span
   (evt)         (evt)          (policy_id or           (scope, reason,       (the tool_call/
                                approver_id +           resource)              llm_call context)
                                reason text)
```

Every hop is an event in the session chain; the dashboard navigates it, and
the whole chain exports as a CGP `graph` frame
(see [trace-model.md §5](trace-model.md)).

## 5. Enforcement at the wrapper

1. Verify Biscuit signature + all caveats offline against cached Mint keys.
2. For `use_limit` tokens, check-and-increment the collector's local nonce
   set (still offline with respect to the control plane).
3. Emit chained `token_use`, then execute.
4. Any verification failure → chained `token_denied`, action not executed.

**Fail-closed throughout.** PDP unreachable: standing grants (local bundle)
still work; elevations queue with a timeout or fail. Unverifiable token: deny.

## 6. Revocation

Short expiry is the primary control (default 120 s makes most revocation
moot). For mid-lifetime revocation, a small CRL of `token_id`s rides the
policy-bundle sync to collectors; wrappers check it during verification.
Device keys and mint intermediate keys are revocable through the same channel.
