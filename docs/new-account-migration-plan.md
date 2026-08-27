# New-account migration plan — from `578673726240` to `916294258235`

**Status:** Cutover in progress — nameservers delegated, propagating · **Old account:** `578673726240` (`us-east-1`/`us-east-2`) · **New account:** `916294258235` (`us-east-1`)

**What's actually running today (2026-08-26):** the VPC/ALB/app node, Aurora
Postgres (all 88 Atlas migrations applied), Redshift Serverless, self-hosted
Neo4j + ClickHouse on the app node, both DNS zones, the
CloudWatch/EventBridge/S3 observability pipeline, and the `stella`/`cgp`
brand stacks. All five nodeservices (`docs`/`stella`/`app`/`api`/`mcp`) are
deployed and verified healthy — individually on the node and end-to-end
through the ALB (via a temporary listener, since deleted). The marketing
site's and CGP's static content are synced into their new S3 buckets.
Nameservers for `oxagen.sh`, `oxagen.ai`, and `contextgraphprotocol.org` were
repointed at the new zones via the Vercel registrar API
(`PATCH /v1/registrar/domains/{domain}/nameservers`) — propagation to public
resolvers is in progress. ACM certificates sit in `PENDING_VALIDATION` until
that propagates; once they validate, re-apply `stacks-new/oxagen` and
`stacks-new/cgp` without the `-exclude` flags to create the CloudFront
distributions and the ALB's HTTPS listener, then apply
`stacks-new/ci-deploy` (blocked until those distribution ids exist) and
point the four GitHub repos' deploy workflows at the new roles/bucket/node.

**Two migration bugs found and fixed while bootstrapping Aurora**, both as
PRs in `oxagen-platform` rather than hand-patched silently:
[#1333](https://github.com/macanderson/oxagen/pull/1333) makes two Atlas
migrations RDS/Aurora-compatible — one is flagged for a human security
review before merge (it touches an RLS-bypass mechanism). See that PR's
description for the full reasoning.

This is the record of what changed and why in moving Oxagen's, Stella's, and
the Context Graph Protocol's AWS infrastructure to a new account, and the
checklist for the cutover steps that have not happened yet. It sits beside
`README.md` rather than replacing it: the old account's design notes (the
CAA trap, the Lambda-behind-CloudFront 403, the certificate ordering trap)
still apply verbatim to the new account's zones and are not repeated here.

---

## 1. Decisions made

| # | Decision | What was chosen | Why |
|---|---|---|---|
| D1 | Scope | All three brands (Oxagen, Stella, CGP) | Same reasoning the old account's README gives for one account: separate accounts isolate harder and need cross-account roles for no benefit at this stage. |
| D2 | Data layer | Aurora PostgreSQL Serverless v2 + Redshift Serverless (managed) + self-hosted Neo4j (unmanaged, on the app node) | See §3. A pure "100% Amazon" answer for the graph piece (Neptune Analytics) has a real floor cost that never reaches zero; Aurora and Redshift both now genuinely scale to ~$0 idle, so they beat self-hosting outright. |
| D3 | ClickHouse's role | Redshift Serverless | ClickHouse Cloud has no permanent free tier (~$66/mo minimum); Redshift Serverless bills per RPU-second and auto-pauses, which is cheaper at this traffic level and keeps the "100% Amazon" stack the user asked for. |
| D4 | Security posture | VPC + ALB in front of the app node, node in a private subnet | User-requested, budgeted at ~$30/month. Replaces the old account's public-IP-plus-Caddy-Let's-Encrypt design with ALB-terminated ACM certs. |
| D5 | NAT | A self-managed `t4g.nano` NAT instance, not a NAT Gateway | ~$3/month vs. ~$32-45/month for a managed gateway, at traffic levels neither would notice. |
| D6 | Cutover | Best-effort live migration | User-approved; accepts some risk of brief disruption rather than a fully staged maintenance window. |
| D7 | Tagging | `Brand` (per-brand, as before) + `Application = oxagen.sh` (new, umbrella) | Both set via each stack's provider `default_tags`, so neither can be missed on a new resource. |
| D8 | Scope exclusions | arenabench (its EC2 rigs, its Route 53 zone, its S3 bucket) and the GCP-fronted `oxagen.ai` services (`admin`/`api`/`clickhouse`/`mcp`/`pgadmin`/`redis`) | arenabench was already ejected to its own repository. The GCP services were never AWS infrastructure to begin with — this is an AWS account migration, not a rehost of something that already runs elsewhere. |
| D9 | Logging/eventing | CloudWatch Logs (all services) -> S3 archive (Firehose, Glacier Deep Archive lifecycle, 14yr) + EventBridge (errors/warnings/incidents) | User-requested. EventBridge substituted for Kafka (MSK) or Redis (ElastiCache), both named as examples of "a channel to subscribe to" — both have a real always-on floor cost; EventBridge is pay-per-event. |
| D10 | DB recovery | Aurora: 35-day continuous backup (max allowed, no extra cost). Redshift: automatic 30-min recovery points (fixed, not configurable). Neo4j: hourly EBS snapshots (was daily). | User asked for ~1-minute RPO, offered 1-day as a cost fallback. Aurora/Redshift hit the 1-minute ask natively. Neo4j is self-hosted with no continuous-backup mechanism; true 1-minute PITR would mean building custom transaction-log shipping, judged disproportionate — hourly is the accepted middle ground, not the 1-day fallback exactly, but far tighter than it. |

---

## 2. Where we are today (old account, `578673726240`)

Confirmed by reading live account state, not by trusting any prior document
(`docs/ops/aws-deployment-plan.md` in `oxagen-platform` describes a
Fargate+Aurora+PrivateLink architecture that was proposed and never actually
built — no ECS services, no RDS, no ElastiCache exist in the account. What
is actually running is what follows):

| Concern | Today |
|---|---|
| Compute | One `t4g.medium` EC2 instance (`oxagen-data`, `i-023d002d6e44f8f84`) running Postgres, Neo4j, and ClickHouse in Docker, *and* Caddy plus five Node processes (docs/stella/app/api/mcp) — one box, both jobs. |
| Networking | Default VPC, public subnet, no NAT (the instance has a public IP; nothing can reach it inbound because the security group opens nothing). |
| TLS | Caddy terminates its own certificates via Let's Encrypt HTTP-01. |
| Sites | `oxagen.sh` (marketing) is genuinely static, S3+CloudFront. `docs.oxagen.sh` and `stella.oxagen.sh` each have a vestigial `nextjs-site` (Lambda) module in Terraform state that has never served traffic — CloudFront in front of a Lambda Function URL returns 403 in this account for reasons never root-caused — so both hostnames were hand-repointed at the node's IP outside Terraform, which is why applying either stack untargeted is a documented trap. |
| DNS | Four zones: `oxagen.sh`, `oxagen.ai`, `contextgraphprotocol.org`, `arenabench.org` (excluded from this migration). |
| CI/CD | GitHub OIDC, four deploy roles, one SSM document (`oxagen-deploy-service`) that runs `deploy-service.sh` on the node — no CI role ever gets a shell on the box. |
| Deploy bucket | `oxagen-deploy-578673726240` — referenced everywhere but created by hand, never a Terraform resource. |

---

## 3. Target architecture (new account, `916294258235`)

```
                         Route 53  (oxagen.sh)
                             |
        +--------------------+-----------------------+
        |                                             |
   CloudFront                                    ALB (public subnets,
   oxagen.sh (S3 OAC)                            ACM cert, HTTP->HTTPS)
                                                       |
                                        ------- private subnet --------
                                        EC2 t4g.medium app node:
                                          Caddy -> docs/stella/app/api/mcp
                                          Neo4j (self-hosted, EBS volume)
                                               |                |
                                        Aurora PG          Redshift
                                        Serverless v2      Serverless
                                        (private subnets)  (private subnets)

   NAT instance (t4g.nano, public subnet) -- outbound only, for the
   private subnets' package pulls / container images / AWS API calls.
```

### 3.1 What changed from the old account's design, and why

- **Postgres -> Aurora PostgreSQL Serverless v2.** Scales to 0 ACU at idle
  (a 2024 feature); at zero customers this is now cheaper than a dedicated
  slice of a shared self-hosted box, and it is a genuine AWS-managed
  service rather than something this repository operates.
- **ClickHouse's role -> Redshift Serverless.** 4 RPU minimum (reduced from
  8 in mid-2025), billed per RPU-second, auto-pauses between queries.
  ClickHouse Cloud's ~$66/month floor made it the more expensive of the two
  managed options, so this is the one that stayed AWS-native by cost as
  well as by preference.
- **Neo4j stays self-hosted**, on the app node's own EBS volume, not
  Neptune. This is the one place "100% Amazon" was weighed against cost and
  lost: Neptune Analytics is Amazon's only graph product with native vector
  search, and even its smallest paused configuration has a real floor
  (~$35/month just to keep the graph's data around, more to keep it always
  queryable) — verified against the live AWS Price List API, not a vendor
  blog. Neo4j 5.11+, already what this app runs, has native vector indexes
  today at zero incremental cost.
- **The node moved from a public IP to a private subnet behind an ALB.**
  TLS termination moved from Caddy's own Let's Encrypt certificates to
  ACM (DNS-validated, auto-renewing). The node's security group now admits
  only the ALB's; there is no port-80 ACME challenge listener to keep open.
- **`docs.oxagen.sh` and `stella.oxagen.sh` are plain node services from day
  one.** No vestigial Lambda module, no hand-overridden DNS record fighting
  Terraform's own state. The old account's documented `-target` trap does
  not exist here because the thing that caused it was never built.
- **The deploy bucket is a real Terraform resource** (`stacks-new/ci-deploy/deploy-bucket.tf`),
  not hand-created drift — the old account's `oxagen-deploy-578673726240`
  exists nowhere in that repository's Terraform.

### 3.2 What did not change

- The CI/CD shape: GitHub OIDC, four per-repository deploy roles, one
  SSM document that runs `deploy-service.sh` and nothing broader — same
  reasoning, same trust-policy design (`StringEquals`, both subject
  spellings, pinned to `environment:production`).
- The `oxagen-run.json` artifact contract and the deploy/rollback script.
- Secrets in SSM Parameter Store, never Secrets Manager, for the same
  per-secret cost reason as before.
- Mail, DKIM, SPF/DMARC, and every domain-ownership TXT record — carried
  over byte-identical via the same `imported-dns*.json` files. Moving which
  AWS account owns a DNS zone does not change where mail is routed.
- The GCP-fronted `oxagen.ai` services (`api`, `mcp`, `admin`, `redis`,
  `clickhouse`, `pgadmin`) — still out of scope, still pointed at the same
  load balancer IP.

---

## 4. Cost

Rough, `us-east-1`, at effectively zero traffic:

| Item | Old account | New account |
|---|---|---|
| Compute (app node) | ~$24/mo (t4g.medium, 3 engines) | ~$24/mo (t4g.medium, Neo4j only) |
| Postgres | included above | ~$0-5/mo (Aurora, scales to 0 ACU) |
| ClickHouse / Redshift | included above | ~$0-5/mo (Redshift, auto-pauses) |
| ALB | none (Caddy terminates TLS) | ~$20/mo |
| NAT | none (public IP, no NAT needed) | ~$3/mo (NAT instance, not a gateway) |
| Route 53 zones | ~$2/mo (4 zones, one excluded) | ~$1/mo (2 zones this stack owns) |
| S3 + CloudFront (marketing site) | ~$1-5/mo | ~$1-5/mo |
| Logging/eventing (D9) | none | ~$3-10/mo (CloudWatch Logs storage, Firehose, Lambda, EventBridge — all near-zero at this log volume) |
| S3 archive (14yr, D9) | none | ~$1-2/mo initially, grows slowly (Glacier Deep Archive is ~$0.001/GB-month) |
| **Total** | **~$29-35/mo** | **~$55-80/mo** |

The new account costs more, mostly because of the VPC/ALB security upgrade
(~$23/mo of the difference) plus the observability pipeline — both explicit,
user-requested tradeoffs, not drift.

---

## 5. What is *not* migrated

- **arenabench.** Its Route 53 zone, its S3 artifact bucket, and its three
  EC2 rigs (`arenabench-burst`, `tb-headtohead`, `stella-vs-cc-rig`, all
  stopped) stay in the old account. It was already ejected to its own
  repository; this migration does not resurrect it here.
- **Any data.** Every managed store in the new account starts empty by
  design (per the user's explicit "infrastructure, not data" instruction).
  Nothing is exported from the old account's self-hosted Postgres, Neo4j,
  or ClickHouse.
- **The GCP-fronted `oxagen.ai` services.** Never AWS infrastructure;
  out of scope for an AWS account migration by definition.

---

## 6. Cutover checklist (not yet executed)

Each step below is independently reversible until nameservers move; after
that, reversing means moving them back, which is itself instant but leaves
whatever changed in between un-synced. Follow the old account's README
cert-ordering and CAA sections verbatim — they apply to this account's
zones exactly as written.

1. **Verify the new account's stack serves correctly** on the ALB's own
   DNS name and the node's `/healthz`, before any DNS points at it. As of
   this writing the node only answers `/healthz` — no service has been
   deployed to it yet.
2. **Deploy the five services** (`docs`/`stella`/`app`/`api`/`mcp`) to the
   new node via the existing artifact contract (manually, once, using an
   AWS key with `ssm:SendCommand` — `stacks-new/ci-deploy`'s roles don't
   exist yet, see step 4), and install the ALB-facing Caddyfile (no TLS, no
   port 80 challenge — `tools/caddy/Caddyfile.alb`, `LOG_DRIVER=awslogs`).
3. **Delegate nameservers** for `oxagen.sh` and `oxagen.ai` at the
   registrar (Vercel — user has pre-approved this) to the zones' own
   `name_servers` output. ACM certificates begin validating only once this
   happens; expect a delay before `PENDING_VALIDATION` clears. Re-run
   `tofu apply` on `stacks-new/oxagen` (without `-exclude` this time) once
   validated — this is what actually creates the CloudFront distributions
   and the ALB's HTTPS listener, both of which were excluded from every
   apply so far specifically to avoid the 75-minute validation hang the old
   account's README documents.
4. **Apply `stacks-new/ci-deploy`** once step 3's CloudFront distributions
   exist — its IAM policies reference their distribution ids for cache
   invalidation, which is why this stack cannot be applied any earlier.
   Then point each of the four CI repositories' `role-to-assume` input at
   the new role ARNs (`stacks-new/ci-deploy` output `role_arns`) and repoint
   their deploy targets at the new bucket (`oxagen-deploy-916294258235`) and
   the new node instance id.
5. **Verify mail continues to flow** — MX, DKIM, SPF, DMARC — before
   declaring the cutover complete. This is the step whose failure is
   silent: a dropped record does not error, it bounces mail hours later
   with nothing pointing back at the change.
6. **Decommission the old account's resources** once the new account has
   run cleanly for a stretch — a separate, later decision, not part of this
   migration's scope.

---

## 7. Known follow-ups

- `oxagen-platform/docs/ops/aws-deployment-plan.md` describes an
  architecture that was never built and should be corrected or retired so
  it stops reading as the current plan.
- `tools/node/deploy-service.sh` and `tools/install-node-scripts.sh`
  hardcode the old account's bucket name, region, and instance id. A
  new-account variant (or a parametrized version of both) is needed before
  the deploy pipeline can target this node.
