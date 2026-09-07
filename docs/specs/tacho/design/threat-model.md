<!-- Re-homed from macanderson/cgp-website docs/design/tacho/threat-model.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho threat model

- Status: draft design
- Date: 2026-08-31
- Parent: [overview.md](overview.md)

Adversaries considered: the agent itself (malicious or manipulated via prompt
injection), the enterprise operating it (incentivized to inflate its score),
whoever compromises a host, and a network attacker. The insurer is a
*verifier*, not a trusted party — proofs must hold without trusting Oxagen.

## 1. Summary table

| Threat | Mitigation |
| --- | --- |
| Malicious agent exceeds scope | Fail-closed enforcement; exact-action caveats; short expiry; single-use limits; a deny is itself a chained event (evidence). |
| Compromised wrapper (lies or omits) | Wrapper holds no minting keys; omissions break the chain visibly (`telemetry_gap`, checkpoint lapses); egress-proxy corroboration; signed build attestation; score penalizes uncorroborated fleets. |
| Replayed or stolen token | Session-key proof-of-possession block; short expiry; collector nonce set for single-use; token bound to the session chain. |
| Enterprise games the score | Exposure weighting (idleness earns nothing); spot audits against retained digests; corroboration bonus; anchored public Merkle roots (history cannot be rewritten); attestation coverage disclosed to insurers. |
| Collector compromise | Per-host device key, revocable via CRL; checkpoints require control-plane countersignature; anchored roots limit rewrites to the un-anchored tail. |
| PII leakage | Capture-time, digest-preserving redaction in the collector; insurer artifacts carry digests and aggregates only; raw retention is enterprise-local. |
| Prompt-injected elevation requests | The PDP treats `reason_text` as untrusted data (the same principle as CGP's "frame content is untrusted"); decisions rest on policy + tier + canonical action, never on persuasive request text; escalation shows humans the requesting span, not just the agent's claim. |

## 2. STRIDE per tier

### Wrapper (in agent process)

- **Spoofing:** an unwrapped agent impersonating a wrapped one — genesis
  events carry the signed build attestation; unattested sessions earn no
  score and are flagged in reports.
- **Tampering:** the agent process can tamper with its own wrapper (same
  address space — accepted limitation). Defense is detection, not
  prevention: corroboration, chain gaps, attestation. Stated honestly in the
  docs; this is why the proxy exists.
- **Repudiation:** every action chained with dense `seq`; gaps are events.
- **Information disclosure:** wrapper buffers may hold payloads briefly —
  bounded ring buffer, memory-only, redaction downstream.
- **DoS:** telemetry is fail-open by design; enforcement fail-closed is the
  *intended* denial.
- **Elevation of privilege:** the wrapper verifies but never mints; the only
  path to new authority is through the PDP.

### Collector (per host)

- **Spoofing:** device key issued at enrollment, mTLS to control plane.
- **Tampering:** WAL rewrites detectable past the last countersigned
  checkpoint; anchored roots bound the rewritable window to the un-anchored
  tail (≤ the anchoring interval).
- **Repudiation:** dual-signature checkpoints.
- **Information disclosure:** redaction happens here; raw bytes storage is
  local and policy-bound.
- **DoS:** collector down → agents keep running (telemetry fail-open,
  standing grants cached); elevations queue or fail — degraded but safe.
- **Elevation:** the collector evaluates cached standing grants but cannot
  mint tokens or widen the bundle (bundle is signed upstream).

### Control plane

- **Spoofing:** carrier and enterprise auth scoped per fleet; mint root keys
  published, rotatable, with overlap windows.
- **Tampering:** trace store is append-only; the daily published Merkle root
  makes retroactive edits publicly detectable.
- **Repudiation:** approval decisions carry policy id or approver id plus
  reasons, inside the chained record.
- **Information disclosure:** insurer API serves aggregates + proofs only;
  per-report consent.
- **DoS:** PDP outage degrades to standing-grants-only fleet-wide — noisy but
  safe; mint keys cached at collectors keep verification working.
- **Elevation:** Cedar policies are analyzable — "could this fleet ever have
  been permitted X" is statically answerable during audit.

## 3. Accepted limitations (stated, not hidden)

1. **Same-process tampering.** A fully compromised agent process can lie to
   its in-process wrapper. Tacho's claim is *tamper-evident*, not
   tamper-proof: lying leaves corroboration mismatches, chain gaps, or
   attestation failures, all of which are priced into the score and disclosed
   in reports.
2. **Proxy-fidelity fleets** see only network/file events; they are labeled
   as such (`fidelity: "proxy"`) and scored against wider posteriors.
3. **The un-anchored tail.** History newer than the last published root is
   rewritable by a full control-plane compromise; the anchoring interval
   bounds the exposure.
