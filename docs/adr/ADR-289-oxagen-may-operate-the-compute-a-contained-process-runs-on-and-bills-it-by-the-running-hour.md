# ADR-289: Oxagen may operate the compute a contained process runs on, and bills it by the running hour

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** platform
- **Decided by:** the maintainer, 2026-10-02
- **Related:** ADR-043 (runtime excision; amended by one more sentence),
  ADR-052 (the billable unit; amended), ADR-096 (the contained tier;
  amended), ADR-152 (the contained launcher and its profiles), ADR-187 (the
  two gateways; amended in part), ADR-198 (an agent is one operator on one
  runtime with one harness; amended in part), ADR-204 (containment is a
  setting of the runtime; amended in part), ADR-101 (the four first-class
  harnesses), issue #5265

## Terms

This record uses these names and no others:

- **Sandbox.** One Firecracker microVM that holds one run's contained
  process. A microVM is a small virtual machine with its own kernel.
- **Sandbox host.** A Linux machine with KVM, the Linux kernel's built-in
  virtualization, that runs Oxagen's sandbox host software. The software
  starts and stops the sandboxes.
- **Oxagen-operated host.** A sandbox host on compute Oxagen operates.
- **Customer-operated host.** A sandbox host the customer runs in its own
  cloud.

## Context

Checked at `main` `9d496304f7`.

- ADR-152's only contained profile, `oxagen-linux-docker-v1`, needs a Linux
  machine with Docker. Most operators work on laptops, and a laptop can't
  run many agents at once.
- On a machine the operator owns, nothing is enforceable against the
  operator (ADR-096). ADR-152 adds that whoever administers the host stands
  outside what containment covers. On compute that Oxagen or the customer's
  platform team operates, the operator does not administer the host, so
  containment holds against the operator.
- ADR-096 already named cloud runners as a target for the launcher.
- ADR-187 already moved model keys to the cloud gateway. It also runs the
  local gateway inside the sandbox in a contained runtime, so no model
  credential has to sit next to the agent.
- ADR-096 rejected a cloud-hosted runner as the only contained option, for
  custody of source code and credentials. This record does not make it the
  only option. The Docker profile stays, a customer can run the sandbox host
  in its own cloud, and no model credential enters the sandbox.

## Decision

### Turns

Oxagen still runs no turn. The harness the customer chose runs every turn:
it builds the prompt, calls the model through the gateways, and picks the
tools.

What changes is where the launcher (ADR-096) may run. Oxagen may now launch
and host the contained process on an Oxagen-operated host. ADR-096's rule
stands: a launcher that confines a process is not an agent runtime. Hosting
that confined process does not make it one.

### Sandbox hosts

Oxagen builds and maintains the sandbox host software itself. It starts one
sandbox per run, with Firecracker, on hosts with KVM.

- A customer may run the same software in its own cloud. Oxagen governs,
  meters, and records runs on a customer-operated host as it does on its
  own.
- Oxagen does not resell a third-party sandbox provider.

### Runtime kinds

A runtime has a kind: `local` or `cloud`.

- **A local runtime** is a machine an operator enrolls, as today (ADR-198
  decision 3). Containment stays a setting of the runtime (ADR-204).
- **A cloud runtime** is one a workspace configures. Its configuration
  names:
  - the sandbox host it runs on, Oxagen-operated or customer-operated
  - the template image
  - the egress allowlist
  - environment variables and secrets
  - the sandbox size
  - the idle pause
- A cloud runtime is never linked to a repository.
- Each run on a cloud runtime gets its own sandbox. No two runs share one.
- A cloud runtime always requires containment. Its containment requirement
  is always on, and no update turns it off.

### Agents and the uniqueness index

The agent model does not change. An agent is one operator on one runtime
with one harness (ADR-198). Runs on one agent may overlap, with no limit on
how many.

The partial unique index `agents_runtime_harness_uniq` gains the operator.
It now allows one live agent per runtime, harness, and operator. Several
operators can each hold their own agent on a shared cloud runtime.

### Run starts and terminal access

Only the operator an agent is bound to may start a run on it or attach to
its terminal. No role or workspace rule widens this. Every action taken
under an agent's identity stays traceable to one person.

- A work order starts a run only on an agent bound to the operator who sent
  it.
- An agent that starts another agent's run (`start_agent_run`) acts for its
  own operator. The start succeeds only when both agents are bound to the
  same operator. It still needs the grant that names both agents (ADR-187
  proposal 10).

### Model credentials

Model credentials follow ADR-187.

- The local gateway runs inside the sandbox and holds a run token.
- The cloud gateway attaches the operator's own credential on the last hop.
- No model credential enters the sandbox.
- Each operator holds their own credential for each harness: an API key, a
  cloud provider credential, or a subscription login. Operators never share
  a credential.
- On a cloud runtime, the cloud gateway holds an operator's subscription
  login and attaches it the way it attaches a key.

### Billing

The governed action stays the platform's unit (ADR-052).

- Compute on an Oxagen-operated host is billed per running sandbox-hour.
- Paused time is not billed.
- A customer-operated host bills no compute.
- Oxagen still bills no model call. The customer pays its model provider
  (ADR-187).

Compute is a third meter, beside the governed action and evidence
retention. ADR-052 says "Nothing in this repo costs more because a run was
long." That sentence no longer holds for hosted compute. A long run on an
Oxagen-operated host bills more sandbox-hours. For everything else, the
sentence stands.

### Harnesses

Claude Code, Codex, and Stella run on cloud runtimes from the start.
OpenCode joins when Oxagen supports it.

A custom harness runs on a cloud runtime when it meets the launcher's
contract:

1. An entrypoint the launcher starts.
2. A model base-URL override that points the harness at the local gateway.
3. Hook support.

Cursor is not on the starting list. Its model traffic goes through its own
backend with no base-URL setting (ADR-101), so it does not meet the
contract's second item.

## Consequences

- The contained launcher gains a sandbox profile. Under ADR-152's rule, a
  new profile takes a new profile name and a new measurement literal. The
  contract adds both when the profile is built, and `oxagen-linux-docker-v1`
  stays.
- The control plane, not the launcher, still decides that a run was
  contained (ADR-152). That rule covers the sandbox profile too.
- Oxagen operates sandbox hosts, and each one starts customer processes.
- Whoever administers a sandbox host stays outside what containment covers
  (ADR-152). On an Oxagen-operated host, that is Oxagen. On a
  customer-operated host, it is the customer's platform team. In neither case
  is it the operator.
- The positioning line "Oxagen does not run agents" stays true for turns.
  `docs/VISION.md` now says the launcher may run on compute Oxagen operates
  or on Oxagen's sandbox host software in a customer's cloud. It also says
  that containing and hosting a customer's agent process is governing, not
  running.
- Billing gains a compute meter. It counts running sandbox-hours on
  Oxagen-operated hosts and skips paused time.
- The index change is a schema change, so its pull request carries
  `MIGRATION-REQUIRED` (SCR-006). The register form then disables a runtime
  and harness pair only when the registering operator already holds an agent
  on it.

## Supersedes and amends

- **ADR-043, by one sentence.** ADR-096's sentence stays, and this one
  joins it:

  > **"Oxagen may host the contained process on compute it operates, and it
  > still runs no turn."**

  Everything else in ADR-043 stands.
- **ADR-096, in part.** The launcher may run on an Oxagen-operated host, as
  well as on CI runners, cloud runners, and managed devices the customer
  brings. Its rejection of a cloud-hosted runner as the only contained
  option stands, because this record adds a hosted option and keeps the
  others.
- **ADR-052, in part.** "Nothing in this repo costs more because a run was
  long" no longer holds for hosted compute. Compute on Oxagen-operated hosts
  is a third meter, billed per running sandbox-hour. The governed action
  stays the billable unit, and tokens stay unbilled.
- **ADR-198 decision 1, in part.** The index bullet's sentence "The operator
  is not in the key: one runtime runs one agent per harness whoever operates
  it" no longer holds. The key gains the operator. The rest of ADR-198
  stands.
- **ADR-187, in part.** Three sentences change:
  - Work orders: "The operator's role is the only limit on which agents they
    can send to." An operator now sends work only to agents bound to them.
  - Coverage limits: "Subscription logins cannot be held by Oxagen." On a
    cloud runtime, the cloud gateway holds the operator's subscription login.
  - Spend: "Oxagen bills governed actions only." Oxagen now bills governed
    actions and running sandbox-hours on Oxagen-operated hosts. It still
    bills no model call.
- **ADR-204 §1, in part.** `update_runtime` cannot turn off containment on a
  cloud runtime.

## Alternatives considered

**Resell a third-party sandbox provider.** Rejected. That provider's
per-hour price would set the floor under Oxagen's hosted price and leave
little margin. Oxagen's cost and features would also move whenever that
vendor changed its terms or its roadmap. Oxagen's own host software keeps
the cost and the roadmap with Oxagen, and a customer can run the same
software in its own cloud.

**Keep containment local-only.** Rejected. ADR-152's profile needs Linux
with Docker, and a laptop runs few agents at once. On a machine the
operator administers, containment does not hold against the operator
(ADR-096, ADR-152).

**Run ADR-152's Docker profile on Oxagen-operated hosts.** Rejected.
Containers on one host share its kernel, and these hosts run many
customers' processes. A microVM gives each run its own kernel. ADR-152
already named Firecracker for a later profile because it holds against a
stronger attacker inside the sandbox.

**One agent per runtime and harness, shared by every operator on the
runtime.** Rejected. Actions under that agent's identity would not trace
to one person.
