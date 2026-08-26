# AWS Deployment Plan — oxagen.sh website + platform infrastructure

**Status: STALE — never executed, describes an architecture this account
does not run.** Verified 2026-08-26 against live account state, not
assumed: this plan's central claim in §2 ("the AWS account is not
greenfield... `infra/environments/production` already manages two KMS
keys") does not hold — `aws kms list-aliases` against `578673726240`
(`us-east-2`) returns zero custom aliases. Only `infra/bootstrap`'s state
backend (the `oxagen-tfstate-578673726240` bucket + `oxagen-tflock` table)
was ever actually applied; the KMS module, and everything in §3 onward
(ECS Fargate, Aurora, Neptune, ALB+CloudFront+WAF), was written but never
run. The account instead moved off Vercel through a completely separate
repository and a completely different architecture — see below.

**Where the real plan and current state live:** `oxagen-aws-infra` (a
sibling repo, not a directory of this one). Its `README.md` documents what
is actually running in `578673726240` today — one self-hosted EC2 node
behind Caddy running Postgres/Neo4j/ClickHouse in Docker, plus the five
platform services as plain Node processes, not the ECS/managed-store
architecture this document specifies. A second migration to a new account
(`916294258235`) is in progress there now; `docs/new-account-migration-plan.md`
in that repo is the live decision record and cutover checklist — Aurora
Serverless v2 and Redshift Serverless replace Postgres and ClickHouse,
Neo4j stays self-hosted, and the app node sits behind a VPC/ALB. Read that
repo before making any AWS infrastructure decision; do not resume executing
the plan below.

**Why this is being left in place rather than deleted:** §4's code-level
TODOs (an S3 storage driver behind `packages/storage`, an `output:
"standalone"` Next.js build, distributed rate limiting, the KMS-IAM-user
finding in §4.8) are about this repository's own application code, are
independent of which infrastructure ultimately hosts it, and may still be
unaddressed. Read them as an application-level backlog, not as a
description of any infrastructure that exists or will be built as specified
here.

---

This is the migration plan for moving the Oxagen website and platform off the
current Vercel + managed-SaaS footprint and onto AWS. It is written to be
executed incrementally: every phase ships independently, and every phase is
reversible by a DNS weight change until the final cutover.

**(Everything below this line is the original, unexecuted plan — kept for
its application-level TODOs per the note above. Its infrastructure
sections do not describe reality; see the banner at the top of this file.)**

---

## 1. Decisions this plan assumes

Three choices drive everything below. They are called out first so they can be
overturned cheaply before any Terraform is written.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Scope | **Full migration** — marketing site, docs, app, API, MCP, workers, and all four stores | Splitting the app from its API across two clouds doubles the egress bill and the latency budget on the hottest path (`POST /api/v1/chat/stream`). Static-site-only is cheap but buys nothing strategically. |
| D2 | Compute model | **ECS Fargate** behind ALB + CloudFront, not EKS | Six long-running services. Fargate has no control-plane cost, no node lifecycle, and no Kubernetes operator burden. EKS is the right answer at ~20+ services or when customers demand in-VPC self-hosting — revisit then. |
| D3 | Next.js runtime | **Container (`output: "standalone"`) on Fargate**, not OpenNext/Lambda | `apps/app` uses Next 16 Cache Components + PPR, streaming SSE, and `proxy.ts`. OpenNext's Lambda split (server/image/revalidate/warmer) is a second, subtly different runtime to debug. A standalone container is the same Node process we already run locally. |

**Strategic note (VISION alignment):** this work directly advances *vendor
neutrality*. Today four capabilities are hard-bound to Vercel primitives —
Blob storage, Sandbox, AI Gateway, and Vercel-injected env. Section 4 turns
each into a driver behind an interface, which is a win whether or not the AWS
migration completes, and is a prerequisite for customer-hosted deployments.

---

## 2. Where we are today

| Concern | Today | Source of truth |
|---|---|---|
| Marketing site (`apps/web`) | Static HTML on Vercel | `apps/web/vercel.json` |
| Docs (`apps/docs`) | Fumadocs, statically generated, Vercel | `apps/docs/next.config` |
| App (`apps/app`) | Next.js 16 App Router, RSC + SSE, Vercel | `apps/app/next.config` |
| API (`apps/api`) | Hono on `@hono/node-server`, Vercel | `apps/api/package.json` |
| MCP (`apps/mcp`) | xmcp HTTP server, Vercel | `apps/mcp/package.json` |
| Postgres | Neon (serverless) | ADR-004 |
| Neo4j | AuraDB | ADR-003 |
| ClickHouse | ClickHouse Cloud | ADR-004 |
| Blob | Vercel Blob (`@vercel/blob`) | `packages/storage` |
| Jobs | Inngest Cloud | ADR-002 |
| Sandbox | Modal (prod) / Vercel Sandbox / Docker | `packages/sandbox` |
| Secrets | Env vars, fanned out to Vercel projects | ADR-004 |
| KMS | **Planned, never applied** — `infra/environments/production` declares `oxagen/ingestion-prod` and `oxagen/auth-tokens-prod`, but no such aliases exist in the account (verified via `aws kms list-aliases`, 2026-08-26) | `infra/environments/production` |
| CI | GitHub Actions, `ghcr.io/oxageninc/oxagen-ci-*` images | `.github/workflows/pipeline.yml` |

Only `infra/bootstrap` was ever actually applied — the state backend
(`oxagen-tfstate-578673726240` + `oxagen-tflock`) exists and is shared with
`oxagen-aws-infra`'s own stacks under different state keys.
`infra/environments/production`'s KMS module was written but never run, and
neither was anything past it in this plan. See the file-level banner above.

---

## 3. Target architecture

```
                      Route 53  (oxagen.sh)
                          │
        ┌─────────────────┼──────────────────┬──────────────────┐
        │                 │                  │                  │
   CloudFront        CloudFront         CloudFront         CloudFront
   oxagen.sh        docs.oxagen.sh     app.oxagen.sh   api/mcp.oxagen.sh
   (S3 OAC)          (S3 OAC)               │                  │
                                       AWS WAF ──────────────  WAF
                                            │                  │
                                    ALB (public subnets, ACM TLS)
                                            │
   ─────────────────────────── private subnets ───────────────────────────
        │              │              │              │             │
   ECS: app       ECS: api       ECS: mcp     ECS: worker    ECS: stella
   (Next 16)      (Hono)         (xmcp)       (Inngest)      (sidecar)
        └──────────────┴──────────────┴──────────────┴─────────────┘
                                    │
   ┌──────────────┬─────────────────┼──────────────┬────────────────┐
 Aurora PG     Neo4j on EC2/     ClickHouse       S3 assets     ElastiCache
 Serverless v2  Marketplace AMI   (Cloud on AWS     + CF OAC      Valkey
 (RLS, oxagen_app) (Multi-AZ)      PrivateLink)                  (rate limit)
```

### 3.1 Service mapping

| Component | AWS target | Notes |
|---|---|---|
| `apps/web` | **S3 + CloudFront (OAC)** | Pure static. Cheapest, fastest, first thing to move. |
| `apps/docs` | **S3 + CloudFront (OAC)** | Fumadocs is fully static (`generateStaticParams`). Build in CI, `aws s3 sync`, invalidate. The `next.config` redirects become a CloudFront Function. |
| `apps/app` | **ECS Fargate**, 2× 1vCPU/2GB min, autoscale on ALB request count + CPU | `output: "standalone"` + `sharp` for image optimization. `proxy.ts` runs in-process (no edge split). |
| `apps/api` | **ECS Fargate**, 2× 0.5vCPU/1GB min | Hono/Node. Long-lived SSE — ALB idle timeout ≥ 300s, deregistration delay 60s. |
| `apps/mcp` | **ECS Fargate**, 2× 0.5vCPU/1GB | Streamable HTTP at `/mcp`; same SSE timeout treatment. |
| Inngest workers | **ECS Fargate service** serving the Inngest HTTP endpoint | See §4.5 on hosted vs self-hosted. |
| Stella sidecar | **ECS Fargate sidecar container** in the api task | Already containerized in CI; pinned by `sidecar.config.json`. |
| Postgres | **Aurora PostgreSQL Serverless v2** (0.5–8 ACU), Multi-AZ | Must keep the `oxagen_app` non-superuser role — `FORCE RLS` depends on it. Neon's branching is lost; replaced by fast-clone snapshots for preview envs. |
| Neo4j | **Neo4j Enterprise on EC2** (Marketplace AMI), Multi-AZ pair, or **AuraDB via PrivateLink** | Recommend starting with AuraDB-on-AWS + PrivateLink (no operational burden, no data migration risk) and moving to self-hosted only if BYO-endpoint customers demand it. |
| ClickHouse | **ClickHouse Cloud on AWS `us-east-2` + PrivateLink** | Self-managing ClickHouse for append-only telemetry is not worth the ops cost. Keeps the vendor but removes cross-cloud egress. |
| Blob | **S3 bucket + CloudFront OAC**, presigned PUT for uploads | Requires a new storage driver (§4.1). |
| Sandbox | **ECS Fargate (docker driver) task-per-run** or keep Modal | `packages/sandbox` already has a `docker` driver; point it at a Fargate-hosted Docker endpoint, or keep Modal (it is not a Vercel dependency and works fine from AWS). |
| SMTP | **Amazon SES** | Drop-in: the code already takes `SMTP_HOST/PORT/USERNAME/PASSWORD`. |
| Secrets | **AWS Secrets Manager** + SSM Parameter Store | Amends ADR-004 (§4.7). |
| Telemetry | **ADOT collector sidecar → CloudWatch/X-Ray**, or keep current OTLP endpoint | `OTEL_EXPORTER_OTLP_ENDPOINT` is already env-driven — no code change. |
| Rate limiting | **ElastiCache Valkey** | Today's limits are per-process; multi-task Fargate makes them wrong. Shared counter store required before scaling past 1 task. |
| Container registry | **ECR** (private, immutable tags, scan-on-push) | CI images can stay on GHCR; runtime images go to ECR. |
| CDN/WAF | **CloudFront + AWS WAF** managed rule groups | Rate-based rule on `/api/v1/chat/stream` and `/api/auth/*`. |

---

## 4. Code changes required (the real work)

Terraform is the easy half. These are the code gaps that will block a cutover
if they are not closed first. Each is independently shippable and each one
improves vendor neutrality on its own.

### 4.1 S3 storage driver — **required, blocking**
`packages/storage` supports exactly two drivers: `vercel-blob` (default) and
`fs`. `client.test.ts` asserts that `STORAGE_DRIVER=s3` throws "unknown
driver". Add `packages/storage/src/s3.ts` implementing the same driver
interface as `vercel-blob.ts` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`),
register it in `client.ts`, extend the `STORAGE_DRIVER` enum in
`packages/config/src/env.ts`, and add `AWS_S3_BUCKET` / `AWS_S3_REGION` /
`AWS_S3_PUBLIC_BASE_URL`. Backfill existing Blob objects with a one-shot
copy script; keep dual-read (S3 first, Blob fallback) for one release.
*Tests:* mirror `vercel-blob.test.ts` + an integration test against MinIO or
a real bucket. Coverage thresholds must not drop.

### 4.2 AI Gateway → provider-direct or Bedrock — **required, blocking**
`packages/ai` uses `@ai-sdk/gateway` (`AI_GATEWAY_API_KEY`), a Vercel service.
Off Vercel it still works over public HTTPS with a static key, so this is not
a hard blocker on day one — but it is a single-vendor dependency on the
metering chokepoint. Options, in order of preference:
1. Keep the Gateway short-term (works from anywhere; one env var).
2. Add a provider-direct path (`@ai-sdk/anthropic`, `@ai-sdk/openai`) behind
   `modelIdOf()`, so `OXAGEN_LLM_*` tiers resolve without the Gateway.
3. Add **Amazon Bedrock** as a provider for customers who require it —
   this is a genuine enterprise sales unlock, not just a migration chore.
All three keep the `@oxagen/ai` chokepoint intact; nothing bypasses metering.

### 4.3 Next.js standalone build — **required, blocking**
Add `output: "standalone"` to `apps/app/next.config` (behind an env flag so
Vercel previews keep working during the transition), add `sharp`, and write
`apps/app/Dockerfile` as a pnpm-workspace-aware multi-stage build
(`pnpm deploy --filter` or `turbo prune`). Same for `apps/api` (esbuild
bundle already exists via `build.mjs`) and `apps/mcp` (`xmcp build` → `dist/http.js`).
Replace `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL` in the
`serverActionsAllowedOrigins` list with the existing
`SERVER_ACTIONS_ALLOWED_ORIGINS` escape hatch, set explicitly per environment.

### 4.4 Vercel Sandbox driver — **non-blocking**
`SANDBOX_DRIVER=vercel` resolves credentials from Vercel OIDC, which will not
exist on AWS. No code change needed if prod stays on `modal`; if we move
sandboxes to AWS, extend the existing `docker` driver to target a Fargate
task endpoint rather than a local socket. Keep the `vercel` driver — it is
still valid for Vercel-hosted customers.

### 4.5 Inngest — **decision, then wiring**
Inngest Cloud invokes our HTTP `/api/inngest` endpoint and does not care where
it runs; the only change is the registered URL and re-issuing
`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`. Self-hosting the Inngest server
on ECS is possible but adds a stateful component. **Recommendation:** keep
Inngest Cloud through the migration; revisit self-hosting separately.

### 4.6 Distributed rate limiting — **required before scaling out**
`RATE_LIMIT_CHAT_PER_MIN` / `RATE_LIMIT_AGENT_EXEC_PER_MIN` and the circuit
breaker (`CIRCUIT_BREAKER_*`) are per-process today. With N Fargate tasks the
effective limit becomes N×. Back them with ElastiCache Valkey before the
first service scales past one task. Same for Better Auth's `rateLimits`
table usage — note the plural-table gotcha when validating against a
prod-equivalent env.

### 4.7 Secrets — amend ADR-004
ADR-004 chose env vars over a secret manager because there was "no GCP
footprint elsewhere." With an AWS footprint, that reasoning inverts: use
**AWS Secrets Manager** for secret values (injected as ECS task-definition
`secrets[]`, never baked into images) and **SSM Parameter Store** for
non-secret config. `packages/config` keeps validating `process.env` with Zod
— resolution happens in the task definition, so no application code changes.
Write **ADR-037 — AWS Secrets Manager for runtime secrets** superseding the
env-var-only portion of ADR-004. The `env-manager` Vercel fan-out gains an
AWS target.

### 4.8 IAM: static keys → task roles — **security fix, do regardless**
`infra/environments/production/outputs.tf` currently mints long-lived IAM
access keys for the two KMS users and pastes them into Vercel env. On ECS,
replace both with **ECS task roles** (no static credentials, automatic
rotation) and delete the IAM users. Until then, add rotation. This is a
standing SOC 2 finding waiting to happen.

---

## 5. Terraform / OpenTofu layout

Extend the existing tree; do not start a new one.

```
infra/
  bootstrap/                     # exists — S3 state + DynamoDB lock
  modules/
    kms/                         # exists
    network/                     # VPC, 3 AZ, public+private+isolated subnets,
                                 # NAT (1 for staging, 3 for prod), flow logs
    ecs-service/                 # reusable: task def, service, ALB target group,
                                 # autoscaling, log group, alarms
    static-site/                 # S3 + CloudFront + OAC + ACM + Route 53
    aurora-postgres/             # cluster, oxagen_app role, param group, backups
    observability/               # log groups, metric filters, alarms, dashboards
  environments/
    production/                  # exists — KMS today, grows to full stack
    staging/                     # new — same modules, smaller sizes, 1 NAT
```

Conventions: `~> 5.0` AWS provider (already pinned), all resources tagged
`Project=oxagen`, `Environment`, `ManagedBy=opentofu`, `Ticket`. Every
`tofu apply` runs from CI with an OIDC role, never from a laptop.

---

## 6. CI/CD

1. **GitHub OIDC → AWS** — one `GitHubActionsDeploy` role per environment,
   trust policy scoped to `repo:oxageninc/oxagen-platform:ref:refs/heads/main`
   (plus an environment-protected role for staging). No AWS keys in GitHub Secrets.
2. **Build & push** — on merge to `main`, build `app`/`api`/`mcp`/`worker`
   images with Docker Buildx + the existing Turbo remote cache, tag with the
   commit SHA (immutable), push to ECR.
3. **Migrate** — reuse the existing `db-migrate.yml` shape: `atlas migrate
   status` gate, then `atlas migrate apply` against Aurora from a task in the
   VPC (or a CI runner through a bastion/SSM tunnel). Keep the "read status
   before applying" rule verbatim — it exists for a reason.
4. **Deploy** — `aws ecs update-service --force-new-deployment` with the new
   task definition; ECS rolling update, `minimumHealthyPercent=100`,
   `maximumPercent=200`, circuit breaker with rollback enabled.
5. **Static sites** — `aws s3 sync --delete` + targeted CloudFront invalidation.
6. **Verify** — post-deploy health check job hits `/health` on each service and
   runs the Playwright smoke subset against the new origin. A failed check
   triggers the deployment circuit breaker's rollback.

`pnpm gate` remains the pre-merge gate; nothing about the local workflow changes.

---

## 7. Phased rollout

Each phase is independently valuable and independently reversible.

### Phase 0 — Foundations (1 week)
- [ ] `network` module: VPC, subnets, NAT, flow logs, security groups
- [ ] ECR repositories with scan-on-push and lifecycle policies
- [ ] GitHub OIDC deploy roles (staging + production)
- [ ] Route 53 hosted zone for `oxagen.sh`, ACM certs (`us-east-2` for ALB, `us-east-1` for CloudFront)
- [ ] Replace KMS IAM users with task roles (§4.8)
- **Exit:** `tofu plan` clean in both environments; CI can assume the deploy role and push to ECR.

### Phase 1 — Static sites (3 days) — *lowest risk, do first*
- [ ] `static-site` module; deploy `apps/web` → `oxagen.sh`, `apps/docs` → `docs.oxagen.sh`
- [ ] Port `apps/docs` redirects to a CloudFront Function
- [ ] Cut DNS with a low TTL; keep Vercel warm for 48h
- **Exit:** both sites serve from CloudFront; Lighthouse ≥ current; all redirects verified.

### Phase 2 — Data stores (1–2 weeks) — *the long pole*
- [ ] Aurora PG Serverless v2 + `oxagen_app` role + `FORCE RLS` verified
- [ ] Neon → Aurora migration: logical replication for the bulk, short write freeze for the cutover
- [ ] ClickHouse Cloud region move (or new AWS service + replay) + PrivateLink
- [ ] Neo4j: AuraDB PrivateLink, or EC2 pair + `neo4j-admin` dump/load
- [ ] S3 asset bucket + CloudFront OAC; run the Blob→S3 backfill
- [ ] ElastiCache Valkey for rate limits
- **Exit:** `pnpm db:check` green against Aurora; row counts reconciled per store; a `SELECT` (not a log line) proves the migration landed; tenant-isolation tests pass against Aurora.

### Phase 3 — Services on ECS (1–2 weeks)
- [ ] Dockerfiles for `app`, `api`, `mcp`, `worker` (§4.3)
- [ ] `ecs-service` module + ALB + WAF; deploy all four to **staging**
- [ ] Full E2E suite green against staging
- [ ] Deploy to production behind a `*-aws.oxagen.sh` hostname, no public DNS
- **Exit:** production ECS stack fully functional on internal hostnames; SSE streams hold for 5+ minutes; e2e green.

### Phase 4 — Traffic cutover (1 week, mostly waiting)
- [ ] Route 53 weighted records: 5% → 25% → 50% → 100% for `api`, then `app`, then `mcp`
- [ ] Watch p50/p95/p99, error rate, and cost at each step for ≥ 24h
- [ ] Re-register Inngest, Stripe webhook, and every OAuth callback URL against the new origins
- [ ] Update `BETTER_AUTH_TRUSTED_ORIGINS`, `SERVER_ACTIONS_ALLOWED_ORIGINS`, `MCP_URL`, `A2A_PUBLIC_URL`
- **Exit:** 100% on AWS for 7 days with no regression.

### Phase 5 — Decommission (2 days)
- [ ] Vercel projects to a paused/archived state (keep 30 days)
- [ ] Delete Neon branches, retire the Vercel Blob store after the dual-read window
- [ ] Update ADR-004 addendum, `CLAUDE.md` production URLs, `docs/ops/` runbooks
- **Exit:** one bill, one console, no orphaned resources.

**Total: 5–7 calendar weeks** for one engineer working steadily; ~3 weeks with two, since Phase 2 (data) and Phase 3 (containers) parallelize cleanly after Phase 0.

---

## 8. Rough monthly cost

Order-of-magnitude only, `us-east-2`, moderate traffic. Validate with the AWS
pricing calculator before committing.

| Item | Est. /mo |
|---|---|
| ECS Fargate — 6 services, ~10 tasks avg | $250–450 |
| Aurora PG Serverless v2 (0.5–4 ACU typical) | $150–400 |
| ALB + CloudFront + WAF | $60–150 |
| NAT Gateways (3 AZ prod, 1 staging) | $130–200 |
| ElastiCache Valkey (2× t4g.micro) | $25 |
| S3 + ECR + logs | $30–80 |
| ClickHouse Cloud (unchanged vendor) | existing |
| Neo4j — AuraDB (unchanged) or EC2 pair | existing / +$300 |
| **Total (excl. unchanged SaaS)** | **~$650–1,300** |

NAT Gateway is the classic surprise line item — use VPC endpoints (S3, ECR,
Secrets Manager, CloudWatch, KMS) to keep traffic off NAT, and run staging on
a single NAT.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Postgres cutover data loss | Critical | Logical replication + short write freeze + verified row counts; rehearse the whole cutover on staging first |
| SSE/streaming broken by ALB/CloudFront buffering | High | ALB idle timeout 300s+; CloudFront origin-request policy that does not buffer; explicit long-stream e2e test before cutover |
| Rate limits multiply across tasks | High | §4.6 is a hard prerequisite for scaling past 1 task per service |
| RLS breaks on Aurora (`oxagen_app` role) | Critical | Tenancy test suite must run against Aurora in Phase 2, not Phase 4 |
| Cold-start/latency regression vs Vercel edge | Medium | CloudFront in front of everything; keep min task count ≥ 2; compare p95 at every traffic weight |
| Better Auth callback/origin drift | High | Every OAuth callback and `BETTER_AUTH_*` value re-verified in staging against prod-equivalent config (see the `rateLimits` plural gotcha) |
| Cost overrun | Medium | Budgets + anomaly detection from Phase 0; tag everything; review weekly during migration |
| Migration stalls half-done across two clouds | Medium | Phases are ordered so a stall leaves a coherent state; the static sites and the S3 driver are useful even if we stop |

---

## 10. Verification (per repo policy — evidence, not claims)

Nothing in this plan is "done" without an artifact written to
`verifications/<session-id>/`:

- `tofu plan` / `apply` output per phase
- `SELECT` output proving each data migration landed (not migration logs)
- `pnpm gate` green on every PR that touches app code
- Playwright screenshots of the app running against the AWS origin
- `curl` transcripts of `/health` on each ECS service and a 5-minute SSE stream
- Row-count reconciliation per store, pre- and post-migration
- CloudWatch dashboard screenshots at each traffic weight

---

## 11. Immediate next steps

1. Confirm or overturn D1/D2/D3 (§1).
2. File the Linear epic + sub-issues (one ticket = one PR):
   - `network` module and OIDC deploy roles
   - S3 storage driver (§4.1)
   - Standalone Dockerfiles (§4.3)
   - Distributed rate limiting (§4.6)
   - ADR-037 secrets amendment (§4.7)
   - KMS IAM users → task roles (§4.8)
3. Start Phase 0 and Phase 1 in parallel — they share only the ACM/Route 53 work.
