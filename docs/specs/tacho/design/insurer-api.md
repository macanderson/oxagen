<!-- Re-homed from macanderson/cgp-website docs/design/tacho/insurer-api.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho insurer-facing product

- Status: draft design
- Date: 2026-08-31
- Parent: [overview.md](overview.md)

Underwriters get **aggregates and proofs, never raw traces**. The pitch is
telematics: a verifiable operational history for an enterprise's agent fleet,
priced into the premium the way a clean tachograph log or dashcam record is.

## 1. Fleet Attestation Report

A signed document per fleet per period (monthly default), containing:

| Field | Description |
| --- | --- |
| `fleet_id`, `period` | Identity and coverage window. |
| `fleet_size`, `active_agents` | Population. |
| `exposure_by_risk_class` | Decayed exposure sums per action class (see [trust-scoring.md](trust-scoring.md)). |
| `incidents` | Counts by severity; no payloads, no descriptions beyond `reason_code`. |
| `score_distribution` | Histogram of agent scores + fleet aggregate. |
| `attestation_coverage` | % of sessions with signed wrapper attestation. |
| `corroboration_coverage` | % of egress cross-checked by the proxy. |
| `telemetry_gap_rate` | Chain-visible gap rate. |
| `merkle_root`, `inclusion_proofs` | The published anchor root for the period and inclusion proofs for every checkpoint the aggregates were computed over. |
| `signature` | Oxagen control-plane signature over the whole report. |

The Merkle material is the point: **any figure is verifiable against the
anchored public log without trusting Oxagen or the enterprise** (R7). A
carrier's actuary can recompute an aggregate from checkpoint commitments and
confirm inclusion.

## 2. API surface

```
GET  /attest/fleets/{fleet_id}/reports/{period}    → signed report (JSON + detached sig)
POST /attest/verify                                → { report | figure, proofs } → verdict
GET  /attest/fleets/{fleet_id}/score               → current fleet score + tier (if consented)
POST /attest/webhooks                              → subscribe: material tier changes,
                                                     attestation-coverage drops
```

Auth: carrier API keys scoped per fleet, valid only while the enterprise's
consent for that fleet is active.

## 3. Privacy boundaries

- **Consent is per report.** The enterprise approves each period's report (or
  enables standing consent per carrier) via a "shareable to insurer" toggle in
  the fleet dashboard. Revocation stops future reports; issued reports remain
  valid documents.
- **Payloads never leave the enterprise boundary.** Insurer artifacts carry
  digests, counts, and proofs only. Raw bytes retention is enterprise-local
  policy (see redaction model, [trace-model.md §3](trace-model.md)).
- The CGP export provider's declared
  `DataFlow { egress_scopes: ["local-only"] }` documents the same boundary on
  the retrieval side.

## 4. Enterprise fleet dashboard (companion surface)

- Score trends per agent and fleet; tier changes annotated with the causal
  incidents.
- Incident drill-down: from an incident to the four-hop traceability chain
  (token → decision → request → span; [approval-tokens.md §4](approval-tokens.md)).
- Approval-queue analytics: escalation volume, human latency, top escalating
  scopes (feeds standing-grant tuning).
- Report review + consent toggle per carrier.

## 5. Commercial logic (context for design choices)

- The dashcam alone is replaceable; the **permission authority** is not —
  once standing grants and elevation run through Tacho, removing it means
  re-answering "who may do what" from scratch. That is why enforcement
  (Phase 2) precedes underwriting (Phase 3).
- Disclosing attestation/corroboration/gap coverage in the report makes data
  quality itself priceable: an enterprise that games its telemetry produces a
  visibly low-quality report and forfeits the discount — the incentive aligns
  without policing.
