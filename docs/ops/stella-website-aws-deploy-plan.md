# Deploying the Stella website (`stella.oxagen.sh`) to AWS

- **Status:** Proposed — no infrastructure applied, no app code changed.
- **Date:** 2026-08-19
- **Scope:** move `macanderson/stella`'s `website/` from Vercel to AWS, owned by
  the same OpenTofu state and account that already backs `infra/`.
- **Two repos are involved.** Infrastructure (`infra/`) and this plan live in
  `oxageninc/oxagen-platform`. The application changes (static export, search
  index, dropping the Vercel SDKs, the CI deploy job) live in
  `macanderson/stella` under `website/` — a separate repository that this
  session can read but not push to. Every task below is tagged **[platform]**
  or **[stella]** so the split is unambiguous.

## 1. What is actually being deployed

`macanderson/stella/website` — the Stella CLI documentation and marketing site.

| Fact | Value |
| --- | --- |
| Framework | Next.js `16.2.11`, App Router, React `19.2.6` |
| Content | Fumadocs (`fumadocs-core`/`-ui`/`-mdx` 16.9.3) over MDX in `content/docs/` |
| Styling | Tailwind v4, self-hosted JetBrains Mono + brand tokens |
| Package manager | pnpm 11.22.0, own lockfile inside `website/` (root of the repo is pure cargo) |
| Payload size | ~1.2 MB of MDX content, ~588 KB of `public/` assets — a small site |
| Intended domain | `stella.oxagen.sh` |
| Today | Vercel; deployed by `.github/workflows/docs.yml`'s `deploy` job, which **skips when `VERCEL_TOKEN` is unset** |

**Read the deploy job's skip condition carefully before planning a cutover:** if
those three repo secrets were never created, nothing has ever published from CI
and the live site (if any) came from dashboard wiring. Confirm what is actually
serving `stella.oxagen.sh` today — `dig stella.oxagen.sh` plus a look at the
Vercel project — before touching DNS. That is task 0.

### The site is *almost* static, and the exceptions are the whole plan

`next.config.mjs` sets `images.unoptimized`, and every page is prerendered, but
`website/README.md` is explicit that this is **not** an `output: "export"`
site. Four things need a server today:

1. **`src/app/api/search/route.ts`** — the Fumadocs search endpoint. Builds an
   in-memory Orama index server-side and answers `?query`/`?limit`/`?tag`, with
   hand-written input caps (query ≤ 128 chars, limit 1–50, ≤ 8 tags).
2. **`src/app/api/hit/route.ts`** — the install-funnel counter. `POST` bumps
   `install:copies` via Upstash Redis `INCR`; `GET` returns both counters as
   JSON with `cache-control: no-store`.
3. **`src/app/install.sh/route.ts`** — serves the install script and bumps
   `install:hits`.
4. **`next.config.mjs` `redirects()`** — 21 permanent (308) redirects: the ten
   consolidated `/docs/api-providers/*` pages, nine `/docs/examples/*` recipes,
   and `/docs/agent-modes/goal-mode`. These are load-bearing for inbound links
   and search ranking; losing them is not an acceptable migration cost.

Plus two Vercel-only dependencies that stop working the moment the origin is not
Vercel: `@vercel/analytics` and `@vercel/speed-insights`, both mounted in
`src/app/layout.tsx`. They post to same-origin `/_vercel/*`, which is why the
CSP can say `connect-src 'self'`. Off Vercel those routes 404 and the
components become dead weight — they must be removed or replaced in the same
change, and the CSP re-checked against whatever replaces them.

## 2. Hosting options, and the recommendation

| Option | Shape | App changes | Ops surface | Est. cost/mo |
| --- | --- | --- | --- | --- |
| **A — S3 + CloudFront (static)** ✅ recommended | `output: "export"`, assets in S3, CloudFront in front, one small Lambda for the funnel endpoints | Moderate, one-time | Lowest — a bucket, a distribution, a function | **~$1–5** |
| B — OpenNext (`@opennextjs/aws`) | Server + image + revalidation Lambdas, S3 assets, DynamoDB + SQS for ISR, CloudFront | ~None | Highest — 4 Lambdas, a queue, a table, an adapter that must track Next releases | ~$5–25 |
| C — Amplify Hosting | Managed git-connected Next SSR | ~None | Low, but opaque; Next 16 support historically lags upstream | ~$5–20 |
| D — ECS Fargate + ALB + CloudFront | `next start` in a container | None | Highest fixed cost; an always-on task for a docs site | ~$35+ |

**Recommendation: Option A.** This is a documentation site whose content is
known at build time; paying for a server per request buys nothing. Option A
also matches the security posture already in `next.config.mjs` (the CSP comment
literally reasons about "a fully static export"). The four exceptions above
have clean static answers, laid out in §4.

**Fallback: Option B** if the team decides not to touch `website/` app code at
all. It is a legitimate choice — it preserves every Next.js feature verbatim —
but it buys zero-code-change at the price of permanently owning an adapter
between Next.js and Lambda. Recommend against for this site; revisit if the
site ever grows genuinely dynamic pages.

Option C is worth one hour of evaluation before committing to A: if Amplify
builds this repo's `website/` root directory cleanly on Next 16, it is the
smallest possible migration. Treat that as a spike (task 1c), not the plan.

## 3. Target architecture (Option A)

```
                      Route 53  stella.oxagen.sh  (A/AAAA alias)
                                     │
                          ACM cert (us-east-1, DNS-validated)
                                     │
                            CloudFront distribution
                     ┌───────────────┼────────────────┐
        viewer-request CF Function    │        /api/hit, /install.sh
        (308 redirect map,            │        → Lambda Function URL (OAC)
         /foo → /foo/index.html)      │           └── DynamoDB atomic counter
                                      │
                        default origin: S3 bucket (OAC, private)
                              ← `next build && next export` output
```

- **Region:** `us-east-2` for the bucket, Lambda, and DynamoDB — matching
  `infra/environments/production/providers.tf`. **The ACM certificate must be
  issued in `us-east-1`**; CloudFront reads certificates only from that region.
  This needs a second aliased AWS provider in the production stack, and it is
  the single most common thing to get wrong here.
- **Bucket is private.** Origin Access Control only, `block_public_acls` and
  friends all on, mirroring the posture of `infra/bootstrap/main.tf`'s state
  bucket. No S3 website endpoint (it cannot do OAC or HTTPS-to-origin).
- **Directory-index rewrite** is why a CloudFront Function is required rather
  than just `default_root_object`: a static export writes `docs/index.html`, and
  CloudFront will not resolve `/docs/` to it on its own.
- **Response Headers Policy** carries the six security headers currently
  produced by `next.config.mjs`'s `headers()` (CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) plus the
  one-year immutable `Cache-Control` for `/brand/*` and `/icons/*`. Those
  headers stop being emitted by Next once the app is a static export, so they
  must be re-expressed at the edge or they silently disappear — verify with
  `curl -I` in §7, not by reading the Terraform.
- **State:** the existing S3 backend
  (`oxagen-tfstate-578673726240`, key `production/terraform.tfstate`,
  lock table `oxagen-tflock`). Add to the existing production stack; do not
  create a second state file for one site.

## 4. Retiring the four server dependencies

| Today | After |
| --- | --- |
| `/api/search` route handler | Fumadocs **static search**: export the Orama index as a build-time JSON asset and search client-side. The existing input caps become moot (no server to protect), but keep the `limit` clamp in the client for sane result counts. Verify search from a cold browser load before cutover — a docs site with dead search is a broken docs site. |
| `next.config.mjs` `redirects()` (21 rules) | A CloudFront viewer-request **Function** generated from the same `CONSOLIDATED` map, so the map stays the single source of truth. Generate the function source in the build, do not hand-copy 21 rules. |
| `/api/hit` (Upstash `INCR`) | One Lambda (Node 22, Function URL, `AWS_IAM` auth via CloudFront OAC) doing DynamoDB `UpdateItem` with `ADD count :1` — atomic, same guarantee Redis `INCR` gave. Keep `counters.ts`'s discipline verbatim: swallow errors, never block. Alternative: keep Upstash and point the Lambda at it, which is a smaller diff and keeps the existing counts. |
| `/install.sh` (bumps `install:hits`) | Same Lambda, second path. **Do not** make this a static S3 object and drop the counter without asking — the install funnel is the site's only conversion metric. |
| `@vercel/analytics` + `@vercel/speed-insights` | Remove both from `layout.tsx` and `package.json`. If RUM is still wanted, choose a replacement deliberately (CloudFront standard logs → Athena is the zero-new-vendor option) and widen the CSP for it explicitly. Do not leave the components mounted and 404ing. |

**Counts do not migrate for free.** If Upstash is dropped, read
`install:hits` / `install:copies` once and seed the DynamoDB items with those
values, or the funnel numbers reset to zero on cutover.

## 5. Work breakdown

### Phase 0 — establish ground truth (before anything else)
- **[platform]** `dig stella.oxagen.sh`, `curl -I https://stella.oxagen.sh` —
  record what serves it today and the current TTL.
- **[platform]** Confirm where `oxagen.sh` DNS is authoritative. If it is not
  Route 53, decide now: delegate the zone, or keep the registrar's DNS and point
  a CNAME at the CloudFront domain. This changes phase 2.
- **[stella]** Confirm whether `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`
  exist. Determines whether the Vercel rollback path in §8 is real.
- **[stella]** Baseline: `pnpm install && pnpm build` in `website/`, record the
  route table Next prints (which routes are `○ Static` vs `ƒ Dynamic`) as the
  before-picture for §7.

### Phase 1 — application: make it exportable **[stella]**
1a. Swap `/api/search` for the Fumadocs static index; delete the route handler.
1b. Remove `@vercel/analytics` and `@vercel/speed-insights`; re-check the CSP.
1c. *(optional spike, 1h)* Try Amplify Hosting against `website/` as-is. If it
    builds and serves Next 16 cleanly, stop and reconsider Option C.
1d. Move the funnel endpoints out of Next: keep `counters.ts`'s error-swallowing
    contract, move the storage call behind a Lambda handler.
1e. Emit the CloudFront redirect function from the `CONSOLIDATED` map at build
    time; then set `output: "export"` and delete `redirects()`.
1f. `pnpm build` produces `out/`; `pnpm typecheck` clean.

### Phase 2 — infrastructure **[platform]**
2a. New `infra/modules/static-site/` — bucket (private, versioned, SSE),
    OAC, CloudFront distribution, response-headers policy, CF Function,
    ACM cert in `us-east-1` via an aliased provider, Route 53 records.
2b. New `infra/modules/install-funnel/` — DynamoDB table (`PAY_PER_REQUEST`,
    matching `oxagen-tflock`'s billing mode), Lambda, Function URL, least-
    privilege role (`UpdateItem`/`GetItem` on the one table, nothing else).
2c. Wire both into `infra/environments/production/main.tf` with the same tag
    block the KMS modules use (`Project`/`Environment`/`ManagedBy`/`Ticket`).
2d. **Deploy IAM via GitHub OIDC, not an access key.** The existing KMS modules
    mint IAM users with long-lived secrets exported as Terraform outputs; do not
    extend that pattern to CI. Create an OIDC provider + a role trusted by
    `repo:macanderson/stella:ref:refs/heads/main`, scoped to `s3:PutObject` on
    the one bucket and `cloudfront:CreateInvalidation` on the one distribution.
2e. `tofu plan` reviewed by a second person before `tofu apply` — this stack
    shares state with production KMS keys.

### Phase 3 — CI **[stella]**
3a. In `.github/workflows/docs.yml`, replace the Vercel `deploy` job with:
    `aws-actions/configure-aws-credentials` (OIDC, `permissions: id-token: write`),
    `aws s3 sync out/ s3://<bucket> --delete` with two cache profiles —
    `/_next/static/*`, `/brand/*`, `/icons/*` immutable for a year; every
    `.html` `no-cache` — then a CloudFront invalidation of `/*`.
3b. Keep the `production` GitHub environment gate; keep the graceful skip when
    the role ARN is absent, so forks are never blocked.
3c. Keep the `build` job untouched — typecheck + build stay the PR gate.

### Phase 4 — cutover **[both]**
4a. Deploy to the CloudFront domain and verify everything in §7 against it.
4b. Publish `stella-aws.oxagen.sh` as a staging alias; soak for 48h.
4c. Drop `stella.oxagen.sh` TTL to 60s **at least 24h before** the flip.
4d. Flip DNS. Watch CloudFront 4xx/5xx rate and the funnel counters for 1h.
4e. Leave the Vercel project deployed but undomained for 7 days as the rollback.
4f. After 7 clean days: restore TTL, delete the Vercel project, remove the
    unused `VERCEL_*` secrets.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| ACM cert issued in `us-east-2` → CloudFront refuses it | Aliased `us-east-1` provider, called out in the module README and asserted in `tofu plan` review |
| One of the 21 redirects silently lost in translation | §7's redirect assertion loops over the `CONSOLIDATED` map itself; a missing rule fails the check |
| Security headers vanish with the Next server | `curl -I` assertion for all six headers, run against the CloudFront domain in phase 4a, before DNS |
| Search dead on arrival after static swap | Cold-browser search test is a named phase-4a gate, not a smoke check |
| Funnel counters reset to zero | Seed DynamoDB from the current Upstash values, or keep Upstash |
| Directory URLs 404 (`/docs/` → no `index.html`) | CloudFront Function rewrite; assert `/docs/`, `/docs/getting-started/`, and a deep leaf in §7 |
| Stale HTML after deploy | `.html` served `no-cache` + full invalidation on every deploy |
| DNS flip with a long TTL leaves users on Vercel | TTL lowered ≥24h ahead; both origins serve identical content during the overlap |
| Terraform blast radius — shared state with production KMS | Reviewed plan; new modules only add resources, touch no existing ones |

## 7. Verification — required artifacts

Per repo policy, every artifact lands in `verifications/<claude-session-id>/`.
Nothing below is optional; "the deploy succeeded" is not verification.

| Proof | Command | Artifact |
| --- | --- | --- |
| Static export is complete | `pnpm build` in `website/` | `stella-web-build.txt` + `out/` file listing |
| Every page answers | crawl the sitemap, assert 200 on each URL | `crawl-200s.txt` |
| All 21 redirects | loop the `CONSOLIDATED` map, assert 308 + exact `Location` | `redirects-308.txt` |
| Security headers | `curl -sI https://<cf-domain>/` | `headers.txt` (all six present) |
| Directory index | `curl -so /dev/null -w '%{http_code}' .../docs/` | `dir-index.txt` |
| Search works | Playwright: load home cold, type a query, assert results | `search.png` |
| Funnel write path | `POST /api/hit`, then `GET /api/hit`, assert count incremented | `funnel-hit.json` |
| DynamoDB is really storing it | `aws dynamodb get-item` after the POST | `funnel-ddb.txt` |
| Rendered site | Playwright screenshots: home, a docs page, `/engine`, `/releases` | `*.png` |
| Infra applied | `tofu plan` (pre) and `tofu output` (post) | `tofu-plan.txt`, `tofu-output.txt` |
| CI deploy green | the GitHub Actions run for the new deploy job | `docs-workflow-run.txt` |
| Post-cutover | `dig stella.oxagen.sh` + `curl -I` resolving to CloudFront | `cutover-dns.txt` |

## 8. Rollback

- **Before DNS flip:** nothing to roll back; the CloudFront domain is unreferenced.
- **After DNS flip, within 7 days:** repoint `stella.oxagen.sh` at Vercel. With
  the 60s TTL from 4c this is a sub-five-minute recovery. This is the reason
  4e keeps the Vercel project alive — do not skip it.
- **Bad content deploy:** the bucket is versioned; re-sync the previous `out/`
  from the last green CI run and invalidate. Faster than reverting the commit.
- **Infrastructure:** `tofu apply` of the previous commit. The new modules only
  add resources, so a revert removes them without touching the KMS keys sharing
  the state file.

## 9. Open decisions — needed before phase 1 starts

1. **Option A or B?** A is recommended and this plan is written for it. B is a
   one-line change to the plan's phases 1–3 and a permanent adapter dependency.
2. **Is `oxagen.sh` in Route 53?** Determines whether phase 2a creates a hosted
   zone and records, or just emits a CloudFront domain for someone to CNAME.
3. **Keep Upstash or move to DynamoDB?** Keeping it is a smaller diff and
   preserves existing counts; moving it removes the last non-AWS dependency.
4. **Replace the Vercel RUM, or drop analytics entirely?**
5. **Why AWS at all?** Worth stating in the PR: Vercel is serving this site
   competently today, and this migration costs real engineering hours. If the
   driver is cost, note that a docs site this size is likely inside Vercel's
   free tier — the AWS bill is ~$1–5/mo, so the saving is not the reason. If the
   driver is consolidation onto one cloud, data residency, or contractual
   requirement, say so; that is a good reason and it belongs in the record.
