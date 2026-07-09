---
name: ai-charge-credits-needs-tenant-scope-in-inngest
type: bug
domain: billing
severity: P1
linear: (none — team-lead dispatched)
date: 2026-07-02
---

**Symptom:** Prod Vercel logs (ai.video / ai.object) showed `TenantScopeError: No active tenant scope — data access out of bounds` at `requireScope → withTenantDb → consumeCredits → chargeCostUsd/chargeUsageCredits → chargeVideoCredits → generateVideoFor`, with msg "generateVideo credit charge failed" / "generateObject credit charge failed". Net effect: every AI generation invoked from an Inngest function billed nothing — free video/image/LLM/embeddings, a revenue leak.

**Root cause:** @oxagen/ai post-call charges (`generate-video.ts`, `generate-object.ts`, `generate-image.ts`, `embed.ts`) route through @oxagen/billing `consumeCredits → withTenantDb → requireScope`, which needs an active AsyncLocalStorage tenant scope. Request-path callers have one; Inngest workers deliberately keep tenant scope tight around their own DB ops (spec §6.2) and do NOT wrap the long LLM/render step. So the charge ran scopeless, threw, and the best-effort catch swallowed it. `stream.ts` already had the fix; the four sibling helpers did not.

**Fix:** each helper captures `getScope() ?? { orgId, workspaceId }` (from trusted telemetry args) and wraps the charge in `runInTenantScope(...)` — mirroring stream.ts's onFinish. Charge stays best-effort but now succeeds in Inngest context. No withSystemDb fallback (never weaken tenancy); runInTenantScope's UUID assertion still fails closed. Commit 9bb5c5bd, branch fix/ai-billing-tenant-scope.

**Guard:** each helper's `*.test.ts` gains two tests whose charge mock calls the REAL `requireScope()` (@oxagen/tenancy is not mocked in these specs), proving the charge succeeds (a) with no ambient scope and (b) with one active. Verified the (a) test fails on old code with the exact prod TenantScopeError. Fixture org/workspace ids had to become valid UUIDs (org_1→UUID) because runInTenantScope validates them.

**Watch-outs:** ANY new @oxagen/ai helper (or anything calling @oxagen/billing consume/charge) that can run inside an Inngest function / ingestion worker MUST establish tenant scope around the billing write — a best-effort catch will otherwise silently hide the unbilled call. Grep pattern: a `charge*Credits(` call not wrapped in `runInTenantScope`. Mocking @oxagen/billing in a test hides this entirely (the mock never hits withTenantDb) — a scope regression test must exercise real requireScope.
