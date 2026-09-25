# ADR-173: A re-enrolled host carries on its predecessor's sessions

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Related:** ADR-058 (the seal grades a session), ADR-172 (a host's seal
  reopens when the host starts the chain again), issue #4201.

## Context

tachod derives a session's uuid from the host's enrollment id and the
harness's session id. Every enrollment mints a new `tacho.hosts` row with a
new public id, and `tacho enroll --force`, adding a harness, and a
harness-only `tacho reassign` each enroll the machine again. So a
re-enrollment gave every live session a new uuid: the session kept working in
Claude Code, and the control plane opened a second run for it that replayed
the transcript from the start. On 2026-09-25 at 00:23 UTC one re-enrollment
split every session open on the laptop into two runs.

Keeping the uuid alone does not fix it. The old uuid's session row belongs to
the old host, and ingest refused any batch for it from another host with
"session belongs to another host". The frames the old enrollment recorded but
had not shipped also name the old enrollment in `host_enrollment_id`, and
ingest refused those with "event names another host". The recording would
stop instead of splitting.

## Decision

1. **A host has a session scope.** `host.json` carries `session_scope`, and
   tachod derives session uuids from it. A new enrollment sets it to its own
   enrollment id. A host enrolled before the field existed derives from its
   enrollment id, which is what its recorded uuids were derived from.
2. **A successor keeps the scope.** An enrollment keeps the scope of the one
   it replaces when both name the same organization and workspace, both carry
   the same device key fingerprint, and the control plane confirmed the old
   enrollment revoked. Anywhere else the scope is the new enrollment id,
   because a session that kept its uuid there would be refused.
3. **Ingest accepts a successor.** A host succeeds another when the other is
   revoked, in the same organization and workspace, and enrolled with the same
   device key fingerprint. Ingest then accepts frames that name the
   predecessor's enrollment, and a batch for a session the predecessor holds.
4. **A session moves on a continuing batch.** The session row passes to the
   successor only when the batch's own chain verifies, leaves no gap after the
   recorded head, and its first new frame links to the recorded `last_hash`.
   The update is conditional on the host it read, so two successors racing for
   one session cannot both take it.
5. **A live predecessor keeps its sessions.** Two enrollments of one machine
   never write the same session at once. Enrollment refuses a second live
   host for one agent key (`agent_has_host`), and the client carries the
   scope only once the control plane confirms the old enrollment revoked, so
   a successor under the same agent key never meets a live predecessor.

## Consequences

- One Claude Code session is one run across `enroll --force`, a harness
  addition, and a harness-only reassign in the same workspace.
- A reassign to another workspace, or an enrollment under another device key,
  still starts new runs for live sessions. That is the safe outcome: the new
  host has no claim on the old workspace's record.
- The device key fingerprint is the one the host stated when it enrolled. The
  control plane does not yet check a signature from that key, so succession
  trusts a host the workspace already enrolled to say it is the same machine.
  The chain condition in rule 4 limits what a false claim can do: it can only
  append to a session at its recorded head, with frames that chain.
- Wiping tachod's state directory mints a new device key, so the next
  enrollment is not a successor and live sessions split as before. That was
  the 00:23 UTC case. Carrying a session across a wipe would need the old key,
  which the wipe destroyed.
- Records keyed on the host rather than the session, such as gateway
  invocations and contained launches, stay with the predecessor. A session
  that moves keeps its frames, cost, and seal on one run, but a report that
  groups by host shows the work before and after the move under two hosts.

## Alternatives rejected

- **Keep one host row per machine.** Re-enrollment would update the row
  instead of minting one. Every enrollment would then rewrite the identity
  that signs the machine's evidence, and a revoked enrollment could not be
  told apart from the live one in an audit.
- **Derive the uuid from the device key.** A session would keep its uuid
  across workspaces too, and a workspace move would hand a live session's
  record to a workspace that did not own it.
- **Let ingest take any session a revoked host held.** Any enrolled host in
  the workspace could then continue another machine's session. The device key
  and chain conditions are what make the claim narrow.
