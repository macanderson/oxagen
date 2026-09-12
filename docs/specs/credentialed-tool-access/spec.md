# Spec: Credentialed Tool Access and the Fleet Channel

- **Status:** Proposed, pre-implementation
- **Date:** 2026-09-12
- **Owners:** platform
- **Position:** `README.md` in this folder
- **Designs:** `mockups.html` in this folder

---

## 1. Summary

Give agents access to systems that need a username and password, a key and
secret, a connection string, or a token, without ever handing the agent the
credential, and without inventing a second authorization plane.

Three moving parts:

1. **A credential plane.** One catalog of credentials, four legacy stores folded
   in behind adapters, a containment tier on every credential, and a **lease**
   as the only thing an agent ever receives.
2. **A broker.** The process that resolves material and performs, or mints
   authority for, the credentialed call. It is the only code with the Postgres
   privilege to read ciphertext.
3. **A real fleet channel.** Typed, bidirectional, cohort-addressable, with a
   delivery lifecycle an operator can read, and with **control, steering, and
   authority separated into three grantable verbs**.

The work splits across three stores that already exist, and the split is the
architecture.

## 2. Constraints that decide the design

These are settled, and they remove most of the option space. Naming them first
saves re-litigating them later.

| Constraint | Source | Consequence |
|---|---|---|
| Oxagen governs agents, it does not run them. | ADR-043, ADR-040 | We cannot inject secrets into a sandbox we provision, because we no longer provision one. The credential story must be brokerage, not injection. |
| Enforcement claims must be honest per tier. | ADR-040 decision 4, tacho criterion 13 | Containment gets a tier with the same discipline, and the weaker tiers are labeled. |
| One grant surface, not two. | `docs/specs/rbac-permissions-plane.md` section 3.3 | Credentials become a `resource_type` on `iam.resource_grants`. No new resolver, no new precedence rules. |
| Biscuit v2 is the token format. | tacho design ADR-0003 | A lease is a Biscuit, attenuable offline down to one tool and one minute. |
| Privileged secret access lands in `security_events`, not only beside it. | ADR-050 | Every lease issue, redemption, and reveal emits a `security_events` row. |
| `withTenantDb` is the one isolation seam. | `docs/specs/tenancy-rls.md` section 4 | Every new table goes in `POLICY_MANIFEST` with forced RLS. No credential path may run under `withSystemDb`. |
| A tenant may run its own Postgres plane. | ADR-042 | The broker must refuse material from a plane whose org does not match the lease's org. |

## 3. Three stores, three jobs

The load-bearing rule: **each store owns exactly one question, and the answer to
"may this happen right now" only ever comes from Postgres.**

| Store | Owns | The question it answers | Never holds |
|---|---|---|---|
| **Git** | Declaration | What may this agent *ask for*, and who approved that in review? | Any secret value. Any live state. |
| **Postgres (RLS)** | Authority, material, ledger | May this principal use this credential for this action right now, and what happened? | Reachability closure. |
| **Knowledge graph** | Reachability, provenance | What can this agent reach, and if this secret leaked, what is tainted? | Any secret value. Any authorization decision. |

Everything below is a consequence of that table.

---

## 4. Git: the declaration plane

An agent's appetite for credentials is a design decision. Design decisions
deserve a diff, a reviewer, a blame line, and a conversation. No secrets manager
gives you those, and that is the gap git fills.

The declaration lives in the customer's repository, alongside the agent
definition the platform already tracks as a source record
(`agent.context_records`, and the source editor described in
`docs/web-app-2.0/workspace/workbench/repos/repo/spec.md`).

```yaml
# .oxagen/access.yaml
apiVersion: oxagen/v1
kind: AccessDeclaration
agent: acme/refund-bot
requests:
  - credential: stripe-live          # a reference, never a value
    tool: mcp.stripe.create_refund
    containment: brokered            # the weakest tier this request may run at
    max_lease_ttl: 5m
    max_uses: 1
    justification: "Refund step in the support playbook"
  - credential: warehouse-ro
    tool: sql.query
    containment: leased
    max_lease_ttl: 15m
    scope: { database: analytics, schema: public, mode: read_only }
    justification: "Reads the refund history before it acts"
```

Four properties make this worth doing:

1. **A declaration is a request, not a grant.** Merging this file grants
   nothing. An attacker who lands a pull request gets a request that no human
   has answered. This is the single most important line in the spec.
2. **The broker requires both authorities to agree.** A lease is issued only
   when the tuple (agent, credential, tool, containment) is *both* present in
   the declaration at a pinned commit *and* allowed by a grant in Postgres. Two
   independent systems, two different compromise paths, and neither one alone
   is sufficient.
3. **The pin is part of the lease.** The lease records the declaration's commit
   SHA. A run's evidence therefore proves which reviewed text authorized it, and
   "the declaration changed after the fact" is detectable.
4. **`containment` in the file is a ceiling, not a request.** A declaration may
   say `brokered`, and a grant may not loosen it. Tightening is always allowed.
   This makes the safe direction the default direction.

Absence is meaningful. An agent with no `access.yaml` can hold no lease. The
platform's answer to "why did my agent get denied" is a diff the customer can
read.

---

## 5. Postgres: the authority plane

### 5.1 Grants reuse the RBAC plane

Add one resource type to `iam.resource_grants`. Nothing else in IAM changes.

| Field | Value |
|---|---|
| `resource_type` | `credential` |
| `resource_id` | `cred_…` public id |
| `action` | `use` \| `lease` \| `reveal` \| `rotate` |
| `effect` | `allow` \| `deny` \| `require_approval` |
| `conditions` | gains `containment_max`, `environment`, `declaration_pinned`, `rate` |
| `expires_at` | gives just-in-time grants for free |

`require_approval` is what makes the fleet channel load-bearing rather than
decorative: it is the effect that turns a tool call into a thread a human
answers.

The fleet channel gets the same treatment, with three verbs instead of one:

| `resource_type` | `resource_id` | `action` |
|---|---|---|
| `fleet_channel` | workspace id, or `*` | `control` \| `steer` \| `authorize` |

That split is what lets an on-call engineer pause a runaway agent without also
being able to hand out production credentials.

### 5.2 Data model

New schema `credential`. Every table carries `org_id` and `workspace_id` NOT
NULL, the audit columns, and the UUID `id` plus `public_id` convention, so every
one of them is `policyClass: "standard"` in `POLICY_MANIFEST`.

**`credential.credentials`** identity and policy. No material.

```
id, public_id ('cred_…'), org_id, workspace_id
slug (citext), display_name, description
kind             text  -- 'workload_identity'|'oauth'|'basic_auth'|'key_secret'|'connection_string'|'delegated'
containment_floor text -- 'brokered'|'leased'|'injected'|'delegated' (the weakest tier ever allowed)
system_id        uuid  -- FK credential.systems: what is on the other side
owner_user_id    uuid  not null  -- a named human, never a team alias
rotation_period  interval
rotated_at       timestamptz
expires_at       timestamptz
status           text  -- 'active'|'rotating'|'revoked'
deleted_at       timestamptz
unique (workspace_id, slug) where deleted_at is null
```

**`credential.material`** ciphertext only, one row per version.

```
id, credential_id, org_id, workspace_id
version        int not null
value_enc      bytea not null
kms_key_id     text not null
created_at, created_by_user_id
unique (credential_id, version)
```

Splitting material from metadata is not tidiness. It means a list query, a
detail query, and every UI read path touch a table that holds no secret, so a
`select *` bug cannot leak ciphertext. That is a structural guarantee, not a
review convention.

**`credential.systems`** the thing behind the credential.

```
id, public_id ('sys_…'), org_id, workspace_id
kind text  -- 'postgres'|'http_api'|'sftp'|'s3'|'smtp'|…
display_name, host, environment_hint
network_mode text -- 'public'|'static_egress'|'reverse_tunnel'|'customer_broker'
```

**`credential.leases`** the only thing an agent receives.

```
id, public_id ('lse_…'), org_id, workspace_id
credential_id, principal_id, agent_id, run_id, attempt_id
tool            text not null      -- exactly one tool
containment     text not null      -- the tier this lease actually ran at
scope           jsonb not null     -- narrowed target: db/schema/mode, path prefix, amount ceiling
declaration_sha text not null      -- the pinned commit that declared it
grant_id        uuid               -- the resource_grants row that allowed it
approval_id     uuid               -- set when a human answered
issued_at, expires_at              -- minutes, not hours
max_uses int not null, uses int not null default 0
revoked_at, revoked_reason
token_digest    bytea not null     -- digest of the Biscuit, never the Biscuit
```

**`credential.lease_uses`** append-only, one row per redemption.

```
id, lease_id, org_id, workspace_id
at, target, status, http_status, latency_ms
request_digest, response_digest, bytes_in, bytes_out
span_id  -- the tacho span this served
```

**`credential.rotations`** the rotation ledger.

`environments.secret_keys` and `environments.secret_values` stay exactly as they
are, and become the environment-variable projection of the same plane. Four
credential stores exist in the tree today (see section 9.1); they fold in behind
adapters rather than being migrated in one cut.

### 5.3 RLS and privilege: the part that survives a TypeScript bug

Row-level security answers "which rows". It does not answer "which process".
Both are needed here, and the second one is missing today.

**1. Manifest and forced RLS.** Every new table above is added to
`POLICY_MANIFEST` with `policyClass: "standard"`, the DDL is generated by
`tools/scripts/gen-rls-migration.ts`, and the existing
`integration/manifest-coverage.test.ts` then proves forced RLS and a
`tenant_isolation` policy on each one. No new test machinery.

**2. A second database role.** Today one role, `oxagen_app`, reaches every
tenant-owned table its policies allow. Add `oxagen_broker`:

- `oxagen_app` gets **no privilege at all** on `credential.material`. Not
  `SELECT`. A handler bug, an over-broad join, or a debug route cannot
  exfiltrate ciphertext, because RLS is never even consulted: the role lacks the
  grant.
- `oxagen_broker` gets `EXECUTE` on the reveal function below, and nothing
  more direct.

This is the same per-role grant discipline the evidence tables already use
(`SELECT, INSERT` and never `UPDATE, DELETE` for `oxagen_app` in
`20260813100000_run_attempt_foundation_expand.sql`).

**3. No read without a receipt, enforced by the database.** ADR-050 decided that
privileged secret access is recorded in both `secret_access_log` and
`security_events`. Make it structural:

```sql
create function credential.redeem(
  p_credential_id uuid, p_lease_id uuid, p_reason text
) returns bytea
language plpgsql security definer set search_path = credential, public as $$
begin
  -- 1. re-assert tenant scope from the GUCs, never from an argument
  -- 2. assert the lease is live, unexpired, under max_uses, and matches the credential
  -- 3. insert the secret_access_log row and the security_events row
  -- 4. increment leases.uses and insert lease_uses
  -- 5. only then return the ciphertext
end $$;
```

The receipt and the read are one transaction, so a read without a receipt is not
a policy the reviewer must remember. It is a state the database cannot reach.

**4. Negative tests, not positive ones.** A guard that only proves the happy
path proves nothing. Three integration tests, each asserting a failure:

- Connect as `oxagen_app`, `select * from credential.material`, assert
  `permission denied`.
- Call `credential.redeem` with an expired lease, assert it raises and that no
  `lease_uses` row was written.
- Set the GUCs to org A, call `credential.redeem` for a lease in org B, assert
  it raises.

**5. One master key per tenant.** Section 9.2 records the current state. The
target: the envelope `kms_key_id` is derived per org
(`org:<orgId>:vault:v1`), wrapped by a real KMS CMK, with an optional
customer-managed key per org. Then ciphertext that crosses a tenant boundary by
mistake is still undecryptable, and "bring your own key" becomes a
configuration rather than a rewrite. The ingestion path already made this move
(`docs/ops/ingestion-key-cutover.md`); the vault follows the same runbook.

**6. Data planes.** ADR-042 allows a customer-hosted Postgres plane. Invariant:
the broker resolves material only from the plane that owns the lease's org, and
a plane mismatch is a hard failure, never a fallback to the shared plane.

---

## 6. The knowledge graph: the reachability plane

The graph earns its place only if it answers questions Postgres answers badly.
Three do.

**Nodes** (metadata only, and the absence of material is a testable invariant):

```
(:Credential {publicId, kind, containmentFloor, status})
(:System     {publicId, kind, host, networkMode})
(:Lease      {publicId, tool, containment, issuedAt, expiresAt})
```

**Edges**, added to `packages/ontology/src/schema.cypher` beside the existing
`Agent`, `Tool`, `SourceConnection`, and `Execution` labels:

```
(:Agent)-[:MAY_REQUEST]->(:Credential)      // from the git declaration
(:Tool)-[:REQUIRES]->(:Credential)
(:Credential)-[:AUTHENTICATES]->(:System)
(:Lease)-[:FOR]->(:Credential)
(:Execution)-[:USED_LEASE]->(:Lease)
(:Message)-[:AUTHORIZED]->(:Lease)          // the human answer that issued it
```

The three questions:

1. **Blast radius.** "`stripe-live` was exposed on Tuesday. Which agents, runs,
   and outputs are tainted?" Traverse `Credential` back through `Lease` and
   `USED_LEASE` to `Execution`, then forward to the artifacts and messages those
   runs produced. In Postgres that is a recursive join across four ledgers, and
   in Cypher it is one bounded traversal. This is the query a customer asks
   during an incident, when the answer has to arrive in minutes.
2. **Transitive reach.** "What can `refund-bot` actually touch?" Not just its
   own credentials, but the credentials required by every tool it may call, and
   by every agent it may dispatch. Variable depth is exactly what the graph is
   for.
3. **Separation of duties.** "Is there any path by which one agent both approves
   a refund and issues it?" A path query over `MAY_REQUEST` and `REQUIRES`.

**Non-goal, stated so it stays a non-goal:** the graph is never consulted for an
authorization decision. Two sources of truth for "may I" is the classic way this
design fails. The graph is for analysis and disclosure, and it is workspace
scoped like the rest of it (`docs/specs/workspace-graph-boundary/`).

---

## 7. The broker

One service, three jobs, and no HTTP route that returns material.

1. **Resolve.** Take a lease, call `credential.redeem`, decrypt in memory.
2. **Act, per containment tier.**
   - `brokered`: perform the call itself. The agent sent an intent; the broker
     attaches the credential, calls the target, and returns the response. The
     material never enters the agent's process.
   - `leased`: mint a derived credential (an STS token, a scoped database role
     password, a signed URL, an OIDC-exchanged access token) and return that.
     The long-lived secret stays put.
   - `injected`: return the material to a named, enrolled runtime, once, over a
     channel bound to that enrollment, and record that the containment is the
     runtime's.
   - `delegated`: return no material. Return a signed instruction the customer's
     own broker redeems.
3. **Record.** Write `lease_uses`, emit the `security_events` row, emit the
   tacho span, and project the graph edges.

Operational rules that keep the claim true:

- The broker never logs material, never returns it in an error, and never
  includes it in a span attribute. Existing redaction is not enough on its own,
  so the broker's response type makes material unrepresentable outside the
  `brokered` path.
- Lease TTLs are minutes. The default is five, the ceiling is the declaration's
  `max_lease_ttl`, and there is no "never expires".
- A lease is single-tool by construction. There is no wildcard tool on a lease.
- Revocation is immediate and fail-closed: a revoked lease fails at redemption,
  and the deny-generation bump already used by `iam.emergency_denies` invalidates
  every outstanding lease in a workspace in one write.

---

## 8. The fleet channel

### 8.1 What it is

Not messaging. The operator-to-agent control channel, carrying three kinds of
traffic with three different authority requirements: **control**, **steering**,
and **authority**. Authority traffic is what makes credentialed access work,
because an agent that lacks a grant has exactly one useful move, which is to
stop and ask.

### 8.2 Defects in what exists today, and the fix for each

Read from `packages/oxagen/src/contracts/tacho.command.dispatch.ts` and
`packages/handlers/src/tacho.command.dispatch.ts`.

| # | Defect today | Fix |
|---|---|---|
| D1 | `payload: z.record(z.string(), z.unknown())`. `message` carries `{ text }` by convention only, so nothing validates it and nothing can render it. | A discriminated union per command kind. `message` becomes `{ kind: 'steer', text, replyTo? }`; authority messages carry the decision, the lease terms, and the reason. |
| D2 | One target per call: `hostEnrollmentId` plus an optional `sessionUuid`. There is no way to address a set. | A `target` union: `host`, `session`, `run`, or `selector` (workspace, agent definition, tag, status). One dispatch returns a per-target delivery ledger, not a single `commandId`. This is what makes it a fleet feature. |
| D3 | A `commandId` and an `outcome`, with no lifecycle an operator can read and no UI at all. | A delivery state machine: `queued`, `delivered`, `applied`, `acknowledged`, plus `expired`, `superseded`, `rejected`, `undeliverable`. Each transition is a timestamped chained event, and `applied` links to the span where it took effect. |
| D4 | No reply channel. The agent cannot ask for anything. | Bidirectional threads. Agent-originated `ask`, `blocked`, and `report` messages. Without this, credential elevation has nowhere to happen. |
| D5 | No idempotency, no supersede, no ordering. Two queued pauses both apply, and a stale `resume` can land after a `cancel`. | A `dedupe_key`, a monotonic `seq` per target, at-most-once application, and supersede rules: `cancel` supersedes everything queued, a newer `pause` supersedes an unapplied `pause`. |
| D6 | Authorization is a hardcoded org Owner or Admin check (`API_KEY_AUTHORIZED_ROLES`) in the handler. You cannot grant "may pause" without granting "may hand out credentials". | `resource_grants` with `resource_type = 'fleet_channel'` and actions `control`, `steer`, `authorize`. |
| D7 | A host is org-scoped. The command row takes `workspace_id` from the actor's ambient context, and the session lookup filters only on `host_id`. A workspace A actor can therefore command a session belonging to workspace B on a shared host. | Resolve the target session's own workspace, and authorize against that. Never take the scope from the actor's context when the target carries its own. |
| D8 | Operator text reaches the model with no provenance, so the agent's later actions read as its own. | Every steering message is chained to the operator's principal, projected to the graph as `(:Message)-[:STEERED]->(:Execution)`, and shown as human-origin in the transcript. The text is data, never policy, which is the same rule tacho applies to `reason_text` at the decision point. |
| D9 | No fleet-wide stop. `iam.emergency_denies` covers denies, and messaging has no equivalent. | A `broadcast` target with the same fail-closed guarantee as a deny-generation bump. |

### 8.3 The delivery guarantee, stated plainly

At-most-once application, aligned to a boundary. A command applies at the next
prompt or tool boundary and never interrupts a tool in flight, which is already
the behavior tacho's acceptance criterion 6 requires. Expiry is real: an
unapplied command at expiry becomes `expired` and is never applied later. An
operator reading the thread can always tell which of those happened.

---

## 9. Defects this work has to fix on the way

Per the repository's fix-over-file rule, each of these is named with its
disposition. The first three ride the implementation. The last two need a
decision the maintainer owns.

### 9.1 Four credential stores, four audit stories

There are four separate credential paths in the tree today:

| Store | Path |
|---|---|
| Workspace vault | `environments.secret_keys` / `secret_values`, `packages/plugins/src/vault/` |
| Ingestion connections | `ingestion.oauth_accounts` / `oauth_tokens` / `auth_credentials`, `packages/inngest-functions/src/lib/resolve-connection-auth.ts` |
| Plugin credentials | `packages/plugins/src/credentials/`, `plugin.credential.*` routes |
| Model provider keys | `org.model_credential` routes |

Four stores means four encryption call sites, four rotation stories, and four
answers to "who read our credentials". **Pillar: maintainability and
reliability.** Fix: one plane, four adapters, no data migration in the first
phase. The adapters are thin, and the audit and lease behavior becomes uniform
immediately.

### 9.2 One master key for every tenant

`packages/plugins/src/vault/vault-kms.ts` returns a single key label
(`workspace_vault_v1`) wrapped by one master key from
`AUTH_TOKEN_ENCRYPTION_KEY`, and `packages/plugins/src/credentials/kms.ts`
mirrors it with `MCP_CREDENTIAL_KEY_ID`. Both use the local KMS adapter.
Meanwhile `packages/crypto/src/ingestion.ts` already resolves a real AWS KMS
adapter for its own key id, so the capability exists and the vault did not adopt
it.

Consequences: no per-tenant crypto blast radius, no customer-managed key option,
and rotation that is all-or-nothing across every tenant at once. **Pillar:
stability and reliability.** Fix: per-org key id plus a KMS-wrapped CMK,
following the ingestion cutover runbook. This is a phase of its own because it
needs a re-wrap migration.

### 9.3 The credential resolution path bypasses tenant isolation

`resolve-connection-auth.ts` opens with `withSystemDb`, which is the RLS bypass
seam. So the one code path whose whole job is resolving credentials runs with no
tenant predicate. It filters correctly in its query today, which is exactly the
kind of correctness that a later refactor loses silently. **Pillar: stability.**
Fix: resolve under `withTenantDb` with the connection's own scope, or move it
behind `credential.redeem`, which re-asserts scope from the GUCs and cannot be
called without one.

### 9.4 Sandbox templates were dropped, and the vault spec still assumes them

The 2026-06-24 vault spec binds agents to `(environment, sandbox template)`
pairs and resolves secrets into a `SandboxRequest`. ADR-043 dropped
`environments.sandbox_templates` along with the runtime. So the vault's injection
model has no runtime to inject into, and `agent_environment_bindings` now points
at environments alone. **Decision needed:** confirm that environment binding
without a template is the intended end state, and that this spec's broker
replaces the injection path entirely. Filed rather than fixed, because it is a
product decision, not a defect.

### 9.5 No negative test proves `oxagen_app` cannot read material

Today nothing does, because the privilege separation does not exist yet.
Recorded here so the test lands with the role in the same change, not after it.

---

## 10. The loop, end to end

1. `refund-bot` calls `mcp.stripe.create_refund`. The tacho `PreToolUse` hook
   reaches `authorizeExternalCapability`.
2. No standing grant. The matching `resource_grants` row says
   `require_approval`, so the kernel emits an `approval_request` and the tool is
   **held at the boundary**, not failed.
3. A thread opens on that session on the Fleet page. It carries the agent's ask,
   the committed declaration at its pinned SHA, the credential's containment
   tier, the system on the other side, and the blast radius from the graph.
4. The operator answers in the thread: approve once, approve for this run, grant
   standing, or deny with a reason the agent reads.
5. Approval mints a Biscuit lease attenuated to one tool, one target, five
   minutes, and one use. `credential.leases` records it, and the material has
   not moved.
6. The broker performs the call. `credential.lease_uses` records the redemption
   with request and response digests.
7. The graph gets `Execution -USED_LEASE-> Lease -FOR-> Credential
   -AUTHENTICATES-> System` and `Message -AUTHORIZED-> Lease`.
8. The attempt seals into a `RunEvidenceManifestV1` carrying the lease digests,
   so the evidence proves which authority the run used and who granted it.

Eight steps, and the only new infrastructure is the broker and the lease table.

---

## 11. Rollout

Each phase ships on its own and is useful on its own.

| Phase | Contents | Useful after this phase alone |
|---|---|---|
| **0** | `credential` schema, `POLICY_MANIFEST` entries, generated RLS DDL, `oxagen_broker` role, `credential.redeem`, the three negative tests. | The privilege wall exists even before anything uses it. |
| **1** | Credential catalog capabilities and the vault adapter. Containment tier on every credential. Vault UI. | The four-store sprawl gets one front door and one audit story. |
| **2** | Leases, the broker, `brokered` and `leased` tiers. `resource_type = 'credential'` on `resource_grants`. | Agents can use credentials without holding them. This is the product claim. |
| **3** | The fleet channel rebuild: typed payloads, threads, target selectors, delivery lifecycle, the three verbs, D7's scope fix. | Fleet becomes usable, and defects D1 to D9 close. |
| **4** | The elevation loop: `require_approval` to thread to lease, in one flow. Mobile-first approval. | The demo in section 7 of `README.md` becomes real. |
| **5** | `access.yaml` declarations, the pinned SHA on the lease, and the two-authority rule. | The repository compromise story closes. |
| **6** | Graph projection, blast radius, transitive reach, separation-of-duties queries. | The incident question gets answered in minutes. |
| **7** | Per-org KMS key ids and the re-wrap migration (defect 9.2). Customer-managed keys. | Per-tenant crypto blast radius, and BYOK becomes configuration. |

The ordering is deliberate: the privilege wall comes before anything that could
lean on it, and the graph comes last because it is analysis, not enforcement.

---

## 12. Acceptance criteria

1. Connecting as `oxagen_app` and selecting from `credential.material` raises
   `permission denied`, and a test asserts it.
2. `credential.redeem` with an expired, over-used, revoked, or
   wrong-tenant lease raises, writes no `lease_uses` row, and leaves `uses`
   unchanged.
3. Every successful redemption produces exactly one `lease_uses` row, one
   `secret_access_log` row, and one `security_events` row, in the same
   transaction as the read.
4. A `brokered` credential's material never appears in any span attribute, log
   line, error body, or agent-visible response, proven by a test that asserts on
   the full emitted telemetry of one brokered call.
5. A lease is issued only when the tuple (agent, credential, tool, containment)
   is present in the declaration at the pinned SHA and allowed by a grant. A
   declaration-only tuple and a grant-only tuple both deny, with distinguishable
   reasons.
6. A grant cannot loosen the declaration's `containment`, and a test asserts the
   loosening attempt is refused rather than silently clamped.
7. A principal granted `fleet_channel:steer` can send a steering message and is
   refused an authority message. A principal granted `authorize` can answer an
   approval and is refused `control`.
8. A workspace A actor is refused a command targeting a session owned by
   workspace B on a host they share (defect D7), and the refusal is a
   `security_events` row.
9. Two identical `pause` dispatches with the same `dedupe_key` produce one
   applied command. A `cancel` supersedes a queued `pause`, and the superseded
   command shows `superseded` with the id that replaced it.
10. A command unapplied at `expires_at` becomes `expired` and is never applied,
    and the thread shows which of `applied` or `expired` happened.
11. A `broadcast` stop refuses every non-read-only tool on every enrolled host
    within one ingest interval, and fails closed when the control plane is
    unreachable.
12. A revoked credential invalidates every outstanding lease on it within one
    ingest interval, and subsequent redemptions fail closed.
13. The product never labels an `injected` or `delegated` credential with
    `brokered` language, asserted by a copy test over the tier strings in the
    same style as tacho's criterion 13.
14. Blast radius for a credential with 1,000 leases and 10,000 uses returns in
    under two seconds, and names every tainted run and artifact.
15. No `(:Credential)` or `(:Lease)` node carries a property holding secret
    material, asserted by a schema test over the projected properties.
16. No credential resolution path runs under `withSystemDb`, asserted by a lint
    rule in the style of `eslint.tenancy-seams.mjs`.

---

## 13. Open questions a maintainer owns

1. **Where does the declaration live when the customer has no repository?**
   Recommendation: the agent definition's source record is already git-backed
   through the workbench, so use that, and treat `access.yaml` in a customer
   repo as the same file reached a different way. Needs confirmation.
2. **Does `injected` ship at all in phase 2, or wait?** It is the tier customers
   will ask for first, because `psql` and `aws` need material in-process, and it
   is the weakest. Recommendation: ship it in phase 2 behind a per-credential
   opt-in with a named owner, because withholding it pushes customers back to
   pasting keys into environment variables, which is strictly worse.
3. **Confirm defect 9.4**: is environment binding without a sandbox template the
   intended end state?
4. **Customer-managed keys in phase 7, or earlier?** It is a common enterprise
   procurement checkbox, and pulling it earlier costs a re-wrap migration on a
   smaller dataset.
