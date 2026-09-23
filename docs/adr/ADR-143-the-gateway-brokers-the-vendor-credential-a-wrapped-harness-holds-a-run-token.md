# ADR-143: The gateway brokers the vendor credential: a wrapped harness holds a run token

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owners:** platform, desktop
- **Decided by:** the maintainer, 2026-09-22, asking for the part of the plan
  that makes Oxagen a real control plane gateway and forces a wrapped agent to
  get its credentials from it
- **Related:** ADR-094 (the gateway; amended here), ADR-095 (the tier ladder),
  ADR-096 (the contained tier), ADR-078 (two keys, and the leaf constraint on
  `@oxagen/tacho`), ADR-131 (`fundedBy` and `modelKey` are two facts), the
  Mission Control spec §6.2 (run tokens), §6.8 (the credential broker) and
  §7.1 (the three seams), the ARP design ("Keep keys outside agent code",
  "Yes, Oxagen is a real model gateway")
- **Delivered by:** this change, in `packages/tacho`. The final planned
  enhancement of the tacho gateway before the contained tier

## Context

Phase 4 (ADR-094) put `tachod` between a wrapped harness and its model vendor.
The audit of 2026-09-21 (`docs/audits/2026-09-21-model-gateway-arming.md`)
found the proxy watching rather than governing, and one line of its table
names the gap this record closes: *whether the harness was pointed at the proxy
at all is enforced by nothing*. The harness kept its own vendor key. Pointing
the harness back at the vendor, or calling the vendor from any other process
with the same key, went around the gateway and left no trace.

ADR-094 chose that shape on purpose, against a cloud-hosted proxy: "the vendor
credential stays on the machine. The proxy forwards the harness's own
authorization header. Oxagen never holds it." Both reasons stand. A cloud proxy
would move the credential off the machine and put every prompt body through
Oxagen's network. But the sentence bundled two things: *where* the credential
is held (the machine) and *which process on the machine holds it* (the
harness). Only the first was load-bearing.

The specification already said what the second should be. §6.8: "A wrapped
agent holds no credentials. It holds one run token that is good for talking
to Oxagen and nothing else." §6.2: run tokens are "minted by the gateway at
run start. The default life is fifteen minutes." Both were marked a target and
built for tool credentials. The ARP design, which this repository's gateway
descends from, put it as a rule: "The model proxy stores the key; the device
never sees it," with a placeholder credential in the agent's environment and a
broker that "dispatches using broker-held credentials." Its audit added the
one refinement this record keeps: a lease's expiry is server-issued with a
published ceiling, and a caller may only ask for less.

The proxy's inbound side also accepted anything on loopback. `model-proxy-
listener.ts` said so: "a local process gains nothing here it could not get by
calling the vendor directly." That was true while the proxy held nothing. The
moment it holds a key, an unauthenticated loopback listener is a key anyone
on the machine can spend.

## Decision

The gateway takes the model vendor's credential into its own custody on the
machine, and the harness is given a **run token** in its place.

1. **Custody.** `tacho enroll` seals before it edits: the keys are read off
   the harness's own files (`env.ANTHROPIC_API_KEY` or `env.ANTHROPIC_AUTH_TOKEN` in Claude
   Code's `settings.json`; `OPENAI_API_KEY` in Codex's `auth.json`) or from
   `TACHO_BROKER_<PROVIDER>_API_KEY` in the enrolling shell, sealed in
   `credentials.json` under `TACHO_HOME`, AES-256-GCM under a key in its own
   file beside it, both mode 0600 (`packages/tacho/src/host/credential-store.ts`),
   and only then are the files rewritten, so a crash or a store fault between
   the two leaves every key where it was and never nowhere. A harness whose
   file could not be pointed at the gateway has its key released again, so
   custody never holds a key for a harness that still sends its own.
   The secret never appears in a sidecar, a frame, a log line, a status report
   or the wire to Oxagen's servers. The vendor credential still stays on the
   machine. Oxagen's servers still never hold it.
2. **Run tokens.** The gateway signs `oxrt_` tokens with an HMAC key of its own
   (`run-token.key`), naming the host enrollment, the harness, the provider,
   a placement and an expiry (`packages/tacho/src/host/run-token.ts`). The
   ceiling is fifteen minutes, the specification's figure; a caller may
   shorten a token and never lengthen one. Claude Code's `apiKeyHelper` is set
   to `tacho credential issue --harness claude-code`, which prints a fresh
   token; Claude Code re-runs it every five minutes and on any 401. Codex has
   no helper and reads a static value, so it is written a `static` token
   bounded by the enrollment's expiry, and the proxy checks host status and
   the signing key on every call, so that token dies with the enrollment too.
   Every mint is a `token_issued` frame on the host's chain: the token's id
   and expiry, never the token. Only the daemon mints. When it does not
   answer, `tacho credential issue` prints nothing and says why, because the
   proxy the token would be spent at is the daemon, and a token minted around
   it would buy nothing but an unrecorded credential. The daemon renews a
   static token itself, once an hour, when the one in `auth.json` no longer
   verifies for the enrollment or is within seven days of its expiry, so a
   brokered Codex never stops at the token's end.
3. **The proxy verifies and swaps.** A provider with a credential in custody
   is *brokered*: every call to it must carry a run token, the proxy verifies
   the signature, expiry, host and provider, drops the token, attaches the
   custody credential in the vendor's own header, and forwards. A call that
   brings a vendor key of its own is refused (`foreign_credential`), because a
   key in the shell's environment wins over Claude Code's helper and that is
   exactly the bypass custody exists to close. A call with no credential is
   refused (`run_token_required`). An expired or foreign-signed token is
   answered 401 in the vendor's error shape, which is the one refusal the
   harness acts on by itself. A provider with nothing in custody is
   *harness held* and its calls cross as they did under ADR-094.
4. **The record says which.** Every frame the proxy seals carries
   `oxagen.credential_basis`, `gateway_brokered` or `harness_held`, and a
   brokered call carries `oxagen.run_token_id`. The daemon's health report
   names which providers are brokered. `tacho status` and `tacho credential
   status` say where each harness gets its credential and what is in custody,
   by provider, kind, source and date.
5. **Restore is exact.** `tacho unenroll` gives every key back to the file it
   came from (creating the file when it is gone), removes the helper or the
   static token, then shreds the store and the signing key, before the base
   URL comes out and long before the daemon stops. Custody is released only
   once the file says the key landed; a file that already holds a key of the
   person's own keeps it, and the older one in custody is discarded with a
   warning. A store that cannot be opened stops nothing on unenroll: the
   tokens come out anyway, since the gateway they worked at is going, and the
   warning names the key to set by hand. `tacho enroll --credentials
   passthrough` does the same without unenrolling, and there an unreadable
   store keeps the tokens in place, since the gateway stays. Uninstall leaves
   the harness signed in as it was.
6. **Subscription logins are left alone.** A claude.ai login has no key to
   take; the helper wins over it, so a brokered host sends the run token
   however the person signed in, and a login sent beside the token is dropped
   with it. A ChatGPT login in Codex's `auth.json` cannot be brokered, with or
   without a key beside it, and stays `harness_held`: chatgpt.com takes no API
   key, so a call carrying a `ChatGPT-Account-ID` crosses as the harness's own
   whatever the host holds for OpenAI.

### Why this and not the alternatives

- **The gateway holds it, not Oxagen's servers.** Every reason ADR-094 gave
  against a cloud proxy still holds. Custody on the machine adds no hop, no
  cloud dependency, and no transit of prompt bodies or credentials through
  Oxagen. The one change is which local process reads the key from disk.
- **A run token, not the vendor key with a base URL.** With the vendor key
  removed from the harness, reverting the base URL no longer reaches the
  vendor: the harness has nothing the vendor accepts. That is the difference
  between a gateway a person can step around by editing one line and a
  gateway whose bypass requires recovering a key from a sealed store.
- **Loopback is no longer enough.** The proxy now authenticates its caller.
  Any local process without a run token is refused, and any process with one
  is recorded by token id.
- **Fifteen minutes, server-issued.** The ARP audit's finding: a caller-chosen
  expiry lets the caller mint a long-lived credential handle. The ceiling
  lives in the codec and is published there.

### What this does not claim

The tier ladder (ADR-095) is unchanged. A brokered run is on `gateway` for the
traffic that routed, and `gateway` still does not earn the word "enforced"
against the machine's operator. The person who owns the machine can read
`credentials.key`, decrypt `credentials.json` and call the vendor. What
custody changes is that this is now the bypass, rather than editing a base
URL, and that a run outside the gateway leaves the harness with no working
credential. Only the contained tier (ADR-096) closes the rest.

Cursor and Stella are not brokered, because neither routes its model traffic
through the gateway (ADR-101, the audit's §1). Their hooks are unchanged.

## Consequences

- ADR-094 is amended. "The proxy forwards the harness's own authorization
  header. Oxagen never holds it" becomes: the proxy forwards the harness's own
  header on a harness-held provider, and substitutes the credential in its
  custody on a brokered one. "Oxagen never holds it" stands for Oxagen's
  servers and is no longer true of the daemon on the machine. "The vendor
  credential stays on the machine" stands unchanged.
- ADR-078 §4's leaf constraint holds: the codec, the store and the writer are
  in `@oxagen/tacho` and import no `@oxagen/*` package.
- ADR-043 holds. The proxy still forwards a request the harness made; it
  assembles no turn and picks no model. It now holds a credential, which
  ADR-094 said it did not, and this record is where that changed.
- `docs/specs/gateway/spec.md` §4 said custody would be "an ADR that
  supersedes ADR-094, not a line in this spec." This is that ADR, and the spec
  is amended to cite it.
- The Mission Control spec's §6.2 and §6.8 stop being ahead of the code for
  model credentials. Tool credentials through the MCP aggregator remain a
  target.
- `tacho enroll` brokers by default. A host enrolled before this change is
  brokered the next time `tacho enroll` runs on it. The desktop installer
  runs the same command and needs no change of its own.
- The server reads `credentials` off the daemon's health report and stores
  nothing new. Showing the basis on the Agents page is app work that follows.

## Alternatives considered

**A bundle field that requires brokering.** A workspace could mandate that
every host broker, refusing `harness_held` traffic from the control plane's
side. Rejected for now: `budget.mode` is still hardcoded `observed` on the
server (the audit's PR 1) and a second unset policy field would be another
promise the surface cannot keep. The host-level mode is the control, and the
health report is the evidence a later workspace policy would read.

**An OS keystore.** The credential and its key could live in the macOS
Keychain or a Linux secret service, as the ARP CLI specification asks. Deferred
by a seam rather than rejected: the key file is the one thing a keystore would
replace, and nothing else in the store would change.

**Per-call credentials from Oxagen's vault.** The credential broker of §6.8
mints a narrowed credential per tool call from connections the server holds.
That is the right shape for tool servers, where the provider offers token
exchange or restricted keys, and it is the MCP aggregator's work. A model
vendor offers no per-call narrowing and its key is the customer's own, so the
model credential stays on the machine.
