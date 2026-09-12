# Credentialed Tool Access and the Fleet Channel

- **Status:** Proposed position, pre-implementation
- **Date:** 2026-09-12
- **Owners:** platform
- **Contents:** `README.md` (the position), `spec.md` (the architecture),
  `mockups.html` (high-fidelity clickable surfaces)
- **Related:** ADR-040 (governance plane refocus), ADR-043 (runtime excision),
  ADR-050 (secret access in the main audit log), ADR-042 (tenant data planes),
  `docs/specs/rbac-permissions-plane.md` (the grant model this reuses),
  `docs/specs/tacho/spec.md` (the seam into agents we do not run),
  `docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md`
  (the vault this supersedes in part)

---

## 1. The pain

An agent is only worth running if it can touch something real. Something real
means a database, a payment processor, a ticketing system, an SFTP drop, or a
vendor API. Every one of those wants a credential: a username and password, a
key and secret, a connection string, or a token.

So today a team does the only thing available to them. They paste the key into
an environment variable and hand it to the agent. That one act destroys every
control they have:

- The secret is now in a process they do not audit, in a context window they
  do not read, and in a log line they did not expect.
- The credential is long-lived and broadly scoped, because it was minted for a
  human or a service, not for one agent doing one job.
- When the agent does something expensive or wrong, nobody can say who
  authorized it. The credential is the authority, and the credential has no
  owner at the moment of use.
- When the key leaks, nobody can say what it touched. There is no record that
  ties the key to the runs that used it.

Security teams know this, which is why the honest answer inside most companies
today is "no". Agents are not allowed near production credentials, so agents
stay in demos. That is the real blocker on agent adoption in the enterprise,
and it is a governance problem, not a model problem.

## 2. What we will not do

We will not ship a secrets manager. That market is full, the incumbents are
good at it, and it does not solve the problem above. A secrets manager answers
"where is the key". The question that blocks agent adoption is "who said this
agent could use the key, just now, for that".

We will not put the credential in the agent's context. Not redacted, not
truncated, not behind a tool that returns it. A model that can read a secret
can emit a secret.

We will not claim containment we do not have. ADR-043 settled that Oxagen
governs agents and does not run them. We do not own the Stella host, the
customer's CI runner, or the laptop. Anywhere the material leaves our process,
we say so plainly, in the product and in the report.

## 3. The position

**Oxagen holds the keys so your agents never have to.**

An agent never holds a credential. It holds a lease: short-lived, scoped to one
system and one action, tied to one run, revocable, and recorded. The credential
itself is used by Oxagen, or by the customer's own broker, and the agent gets
only the result.

Three claims, and we can back all three:

1. **The agent cannot leak what it never had.** In the brokered tier the
   material never enters the agent's process. The agent sends an intent, we
   attach the credential, the target answers, and the agent sees the response.
2. **Every credentialed act is attributable to a person.** The chain is person,
   grant, agent, lease, call, evidence. Six hops, each a row, each navigable in
   both directions. A credential used by an agent is never anonymous.
3. **Two independent authorities must agree before a lease is issued.** What an
   agent may ask for lives in git, reviewed as code. What it may actually have
   lives in Postgres, granted by a named human. Neither one alone is enough. A
   repository compromise yields no credentials, and a console compromise yields
   nothing the code did not already declare.

## 4. The containment ladder

This is the part that makes the story sellable, because it is honest about the
tradeoff instead of hiding it. Every credential carries a containment tier, and
the product uses the tier's real name everywhere.

| Tier | Where the material lives at the moment of use | What we may claim |
|---|---|---|
| **brokered** | Only in Oxagen's broker. The call is made by us. | The agent cannot leak it. |
| **leased** | A derived short-lived credential goes to the runtime. The long-lived secret stays in the vault. | A leak expires in minutes and is scoped to one system. |
| **injected** | The long-lived material enters a runtime we do not control. | Redacted, bound to one enrollment, revocable, recorded. Containment is the runtime's, not ours. |
| **delegated** | Oxagen never sees it. The customer's own broker performs the call. | We hold the policy and the evidence, never the secret. |

The rule that keeps it honest: **a weaker tier is never described with a
stronger tier's language.** This is the same discipline tacho already applies to
`enforcement_tier`, where a `harness` session is never called "enforced"
(`docs/specs/tacho/spec.md`, acceptance criterion 13).

We prefer brokered, we support all four, and we never pretend an injected
credential is contained.

## 5. The credential kind ladder

Containment is where the material sits. Kind is what the material is. We prefer
credentials that expire on their own:

1. **Workload identity** (OIDC exchange, no stored secret). Best. Nothing to
   steal at rest.
2. **OAuth** (stored refresh token, short-lived access tokens). Good. The
   platform already does this for ingestion connections.
3. **Static key and secret, username and password, connection string.** Stored
   under envelope encryption, never handed out directly, always wrapped in a
   lease.
4. **Customer-delegated.** We store nothing.

Kind 3 is the one customers actually ask about, because Postgres, SFTP, and a
20-year-old ERP do not do OIDC. We support it, and we say the honest thing: a
static secret cannot be made short-lived, so we make its *use* short-lived
instead. The agent-facing contract is identical across all four kinds. An agent
asks for a lease. It never learns which kind answered.

## 6. Fleet messaging is the same feature

The fleet page today can queue a command to a host or a session: pause, resume,
cancel, message, revoke, refresh bundle, kill
(`dispatch_tacho_command`). It works, and it is thin: the payload is an untyped
blob, one call reaches one target, there is no UI, there is no delivery
lifecycle an operator can read, and the agent cannot reply.

That last gap is the one that matters here. An agent that hits a tool it has no
authority for has exactly one useful move: stop and ask. The channel that
carries the question, and carries back an answer that *changes what the agent
may do*, is the fleet channel. So the channel is not a chat feature. It carries
three kinds of traffic, and they need different authority:

| Traffic | Example | Who may send it |
|---|---|---|
| **Control** | pause, resume, cancel, kill | A fleet operator |
| **Steering** | "skip the staging deploy, go straight to the smoke test" | A fleet operator |
| **Authority** | "approved, here is a five minute lease on the refund key" | A credential approver |

Today all three are one hardcoded check for org Owner or Admin. That means you
cannot let an on-call engineer pause a runaway agent without also letting them
hand out production credentials. Splitting control, steering, and authority into
three grantable verbs is the single highest-value change in this spec.

## 7. What the operator sees

One loop, end to end:

1. The agent calls a tool that needs a credential it has no standing grant for.
   The call is held at the boundary, not failed.
2. A thread opens on that session on the Fleet page. It carries what the agent
   asked for, what its committed declaration said it would need, the
   credential's containment tier, the system on the other side, and the blast
   radius if this goes wrong.
3. The operator answers in the thread: approve once, approve for this run,
   grant standing, or deny with a reason the agent will read.
4. Approval mints a lease. The tool runs. The response comes back.
5. The run's evidence seals with the lease digest, so the record proves what
   authority the run used, and who gave it.

The demo line is short: an agent asks for a production key, a human answers on
their phone in nine seconds, and the receipt names them both forever.

## 8. Why this is durable

The design adds no new authorization plane, no new audit story, and no new
enforcement point. It reuses what is already load-bearing:

- `iam.resource_grants` gains a resource type. The resolver's eight precedence
  rules, `expires_at`, and `conditions` all work unchanged
  (`docs/specs/rbac-permissions-plane.md`, section 3.3).
- Biscuit v2 is already the chosen token format for tacho approvals, and it is
  attenuable offline, which is exactly what a lease needs.
- `security_events` is already the cross-domain trail, and ADR-050 already put
  secret reads in it.
- `withTenantDb` is already the one seam where tenant isolation is enforced.

What is genuinely new is small: a broker, a lease table, one declaration file
format, four graph edges, and a real control channel. Everything else is a
resource type and a role.

Read `spec.md` for the architecture, the data model, the RLS design, and the
defects this work has to fix on the way.
