# ADR-246: CI runs on ephemeral runners in our AWS account

- **Status:** Accepted. Mac set the direction on 2026-10-01. The scaler choice,
  the runner sizes, and the network layout are the agent's, recorded here for
  review.
- **Date:** 2026-10-01
- **Owners:** infra, CI
- **Related:** issue #4994, ADR-207 (the turbo cache in S3), ADR-240 (Parameter
  Store holds every secret, in review in #4933), PR #4922 (OIDC trust moves to
  `oxageninc/product`).

## Context

Twenty agent sessions push to `oxageninc/product` all day, and CI is the only
place this team builds and tests code. On 2026-09-30 and 2026-10-01, more than
100 runs sat queued while 2 to 20 jobs ran.

### Baseline

Measured from the Actions REST API on 2026-10-01, sampling 4 `CI` runs a day
from 2026-09-24 to 2026-10-01 (32 runs, 301 jobs) plus 60 runs of every
workflow from the newest 1,000. Queue time is a job's `started_at` minus its
`created_at`. Run time is `completed_at` minus `started_at`.

| Measure | Value |
|---|---|
| Runs of every workflow | 1,970 to 2,500 a day. The API caps this count at 2,500, so read it as "at least" |
| `CI` runs | 162 to 646 a day, 373 on average over 7 full days |
| `CI` job queue time | p50 44 s, p95 1,272 s, max 1,647 s |
| `CI` job run time | p50 124 s, p95 866 s |
| `CI` job-minutes per run | 39.5 on average |
| `unit` | queue p95 1,574 s, run p50 478 s, run p95 883 s |
| `build` | queue p95 1,574 s, run p50 208 s, run p95 839 s |
| Small workflows (`triage-guard`, `dod-check`, `ci-superseded`) | queue p50 17 to 24 minutes for jobs that run 5 to 15 seconds |

Every day from 2026-09-26 on had a `CI` queue p95 between 9 and 26 minutes.

### Limits we do not control

- **Size.** A GitHub-hosted Linux runner in a private repository has 2 cores
  and 7 GB. `@oxagen/api#build` died out of memory (exit 134), and the API
  typecheck runs with a pinned heap.
- **Billing.** On 2026-09-18, and again around 2026-09-30, every job failed in
  1 to 2 seconds with "The job was not started because your account is locked
  due to a billing issue." Nothing in the repository could unblock it.
- **Concurrency.** The plan's concurrent-job limit and its spending limit both
  sit with GitHub.

### What GitHub charges for

GitHub's billing documentation says Actions usage is free on self-hosted
runners. GitHub announced a $0.002 per-minute platform charge for self-hosted
runners in December 2025 and postponed it within a week. It charged nothing as
of July 2026. One public report (Startempire-Wire/focusa#348) describes an
account under a billing lock where GitHub-hosted jobs were rejected and
self-hosted jobs kept running.

Mac asked on 2026-10-01 for an architecture with no dependency on GitHub
billing wherever that is possible, and approved the AWS spend that takes.

### What the account had on 2026-10-01

- EC2 quotas of 32 spot vCPUs and 32 on-demand vCPUs (Standard families),
  enough for four 8-vCPU machines.
- A Lambda concurrency limit of 10 for the whole account.
- No self-hosted runners in the `oxageninc` organization, and no AWS Budget.
- `fleet-capacity.yml` names `[self-hosted, linux, fleet-capacity]`, a
  dedicated runner for a 24-hour hold. No such runner was ever registered.
- The CI images `oxagen-ci-base` and `oxagen-ci-e2e` are public GHCR packages
  owned by the `macanderson` user. `ci-image.yml` in `oxageninc/product`
  cannot push to them, so their `:latest` tags stopped moving when the
  repository changed owners.

## Decision

### 1. The scaler is `github-aws-runners/terraform-aws-github-runner`

The `multi-runner` module at v7.11.0 (released 2026-08-17) runs the runners.
A GitHub App sends `workflow_job` webhooks to an API Gateway endpoint. A
Lambda matches the job's labels to a runner configuration and queues it in
SQS. A scale-up Lambda starts one EC2 instance per job through EC2 Fleet,
with a just-in-time registration. The runner takes exactly one job, and the
instance terminates. A pool Lambda keeps a set number of idle runners
registered, and a scale-down Lambda removes runners that never got a job.

Runners register to the `oxageninc` organization. Every runner is ephemeral.

### 2. Five runner configurations

| Label | Arch | Size | Instance types | Capacity | Max | Network |
|---|---|---|---|---|---|---|
| `oxagen-large-arm64` | arm64 | 8 vCPU, 32 GB | m8g, m7g, m6g, r7g, r6g `.2xlarge` | spot, on-demand on failure | 250 | CI VPC |
| `oxagen-large-x64` | x64 | 8 vCPU, 32 GB | m7i, m6i, m7a, m6a, m5 `.2xlarge` | spot, on-demand on failure | 100 | CI VPC |
| `oxagen-small-arm64` | arm64 | 2 vCPU, 8 GB | m8g, m7g, m6g `.large` | spot, on-demand on failure | 150 | CI VPC |
| `oxagen-small-x64` | x64 | 2 vCPU, 8 GB | m7i, m6i, m6a `.large` | spot, on-demand on failure | 50 | CI VPC |
| `oxagen-deploy` | arm64 | 4 vCPU, 16 GB | m8g, m7g `.xlarge` | on-demand | 4 | production VPC |

- **Labels.** Each configuration carries one label and no default labels, and
  matches a job only when the job's label set equals it
  (`bidirectionalLabelMatch`). A job that asks for
  `[self-hosted, linux, fleet-capacity]` starts nothing.
- **Arch.** Graviton runs any job that works on arm64. The two x64 pools run
  the rest. The pilot runs on `oxagen-large-x64`, because today's CI images
  are amd64 only. Jobs move to arm64 once the images are multi-arch.
- **Spot.** Every CI pool requests spot with the `price-capacity-optimized`
  strategy across five instance types and five availability zones. When spot
  capacity or the spot quota runs out, the same request falls back to
  on-demand (`enable_on_demand_failover_for_errors`).
- **Ceiling.** At their maximums the pools hold 554 runners. A realistic peak
  of 300 jobs (200 large, 100 small) needs about 1,800 vCPUs.
- **Deploy.** `oxagen-deploy` runs every job that touches production:
  `migration-gate`, `deploy-node`, `deploy-web`, `manual-app-deploy`,
  `db-migrate.yml`, and `store-migrate.yml`. It has its own instance role,
  its own runner group, and its own registration path, so a pull request's job
  cannot read a deploy runner's registration.

### 3. Start time

- **Warm pool.** Each pool keeps idle runners through `pool_config`, sized 0
  until the GitHub App exists. The first sizes after cut-over are 8
  `oxagen-large-x64` for the pilot, then 12 `oxagen-large-arm64` and 8
  `oxagen-small-arm64` around the clock. The runbook records each change and
  its reason.
- **Webhook delay.** `delay_webhook_event` is 5 seconds on a pool with idle
  runners and 0 on the rest. The module default of 30 seconds would spend half
  of the 60-second queue target before scale-up even starts.
- **Scale-up concurrency.** The scale-up Lambda may run 50 copies at once per
  configuration, up from the module default of 1, so a burst of 300 jobs is
  not served one Lambda call at a time. This needs the Lambda quota raised
  first.
- **Image.** The image carries the runner agent, Docker, and every container
  image a job pulls, so a cold runner downloads nothing large before its job.

### 4. Network

- **CI VPC.** A new VPC, `oxagen-ci`, `10.80.0.0/16`, has five public `/19`
  subnets in `use1-az1`, `use1-az2`, `use1-az4`, `use1-az5`, and `use1-az6`
  (8,187 addresses each). `use1-az3` is left out because it offers none of
  the instance types above. Each runner gets a public IPv4 address. The runner security
  group admits nothing inbound.
- **No NAT gateway.** A NAT gateway charges $0.045 for each GB it carries, and
  300 jobs cloning, installing, and pulling images would move hundreds of GB a
  day through it. A public address costs $0.005 an hour. An S3 gateway
  endpoint, which is free, carries S3 traffic (the turbo cache and the
  runner's own files).
- **Separate from production.** CI runs code from any branch, so its runners
  sit outside the production VPC. A misconfigured rule there cannot expose
  Aurora, ClickHouse, or Neo4j to a pull request's job.
- **Deploy pool.** `oxagen-deploy` runs in the `oxagen` VPC's public subnets
  with its own security group. The `ci-runners` stack adds one ingress rule to
  the Aurora security group for that group on port 5432. ClickHouse and Neo4j
  listen on the app node's loopback today, so `migration-gate` keeps its SSM
  tunnels for those two until the change that moves it decides whether the
  node should listen on its private address for the deploy pool alone.

### 5. Image

EC2 Image Builder, defined in Terraform, builds one Ubuntu 24.04 AMI per
architecture every day. No GitHub workflow takes part. Each AMI carries:

- the `actions/runner` agent at a pinned version, and the module's
  `start-runner.sh` from the pinned module release, so the instance needs no
  user-data install (`enable_userdata = false`).
- Docker, Git, `jq`, `curl`, `unzip`, `zstd`, Python 3, the AWS CLI, `gh`, the
  CloudWatch agent, and the tools the GitHub-hosted image ships that our
  host-level jobs use.
- the CI images and the three service images (Postgres, ClickHouse, Neo4j),
  pulled for that architecture.

Image Builder writes each new AMI's id to `/oxagen/ci-runners/ami/<arch>` in
Parameter Store. The scale-up Lambda reads that parameter on every launch,
so a new image takes effect without a Terraform apply. Image Builder keeps the
newest three AMIs per architecture and deletes the rest.

### 6. CI images live in ECR Public

`ci-image.yml` builds `oxagen-ci-base` and `oxagen-ci-e2e` for amd64 and arm64
and pushes them to ECR Public through an OIDC role. It copies the three
service images there too, at pinned tags. ECR Public serves anonymous pulls to
GitHub-hosted and self-hosted runners alike, so the rollback path needs no
registry credentials, and nothing depends on Docker Hub's rate limits from
shared AWS addresses. The images hold only the toolchain (Node, pnpm, Atlas,
`psql`, Playwright's Chromium), and they were already public on GHCR.
`ci-image.yml` stops writing the GitHub Actions cache (`type=gha`).

### 7. Access and credentials

- **Instance role.** A runner's instance role grants only what the module's
  start script needs. It reads and deletes its own registration parameter (a
  tag condition binds each parameter to one instance), reads its pool's
  settings, tags and terminates itself, and writes its logs. No job credential
  comes from the instance.
- **Instance metadata.** IMDSv2 is required with a hop limit of 1, so a job's
  container cannot reach the instance's credentials.
- **Job credentials.** A job assumes the OIDC roles it already uses
  (`gha-turbo-cache`, `gha-deploy-oxagen-platform`, `gha-infra-plan`,
  `gha-infra-apply`). Nothing on a runner holds a long-lived key.
- **GitHub App secrets.** The App's id, private key, and webhook secret live
  in Parameter Store under `/oxagen/ci-runners/github-app/`. Terraform creates
  each parameter, generates the webhook secret, and ignores later value
  changes, so Mac writes the id and the key once. This prefix sits outside
  `/oxagen/ci` on purpose: ADR-240 gives workflow roles read access to
  `/oxagen/ci`, and no workflow may read the App's key.
- **Private repositories only.** Mac installs the App on the private
  repositories alone, so a public repository's jobs never reach the webhook.
  The module's `repository_white_list` repeats that list. The `oxagen-ci`
  runner group admits private repositories only, and refuses public ones.
- **Production group.** The `oxagen-production` runner group admits
  `oxageninc/product` alone, and only these workflows at `refs/heads/main`:
  `pipeline.yml`, `db-migrate.yml`, and `store-migrate.yml`. A pull
  request's run uses its merge ref, so it cannot land on a deploy runner.

### 8. One variable rolls back

Every moved job reads its runner from the repository variable `CI_RUNNERS`:

```yaml
runs-on: ${{ vars.CI_RUNNERS == 'aws' && 'oxagen-large-x64' || 'ubuntu-latest' }}
```

Setting `CI_RUNNERS` to `github` (or deleting it) sends every job back to
GitHub-hosted runners on the next run. The deploy jobs fall back to
`ubuntu-24.04-arm`. Private repositories other than `product` read an
organization variable of the same name.

### 9. Alarms, budget, and logs

- **Queue depth.** An alarm fires when a pool's SQS queue holds a message
  older than 120 seconds for 5 minutes.
- **Failed scale-up.** An alarm fires on scale-up Lambda errors and on
  messages that reach the build queue's dead-letter queue.
- **Webhook.** An alarm fires on webhook Lambda errors or API Gateway 5xx
  responses.
- **Budget.** An AWS Budget for the stack's `Stack` tag alerts Mac by email at
  80% and 100% of the forecast monthly spend.
- **Logs.** Lambda and runner logs keep 30 days.

### 10. What still bills through GitHub

| Surface | Decision |
|---|---|
| Linux jobs in private repositories | Move to our runners. No GitHub charge |
| Jobs in public repositories (`brand`, `context-graph-protocol`, `stella-lang`, `.github`, `oxageninc.github.io`) | Stay on GitHub-hosted runners, which are free for public repositories. Our runners never serve them |
| macOS and Windows jobs (`desktop.yml`, `desktop-rig.yml`, `harness-bridges.yml`) | Stay on GitHub-hosted runners in this project. The module supports Windows runners and EC2 Mac dedicated hosts. An EC2 Mac host (`mac2-m2.metal`, about $0.88 an hour, 24-hour minimum allocation) is the follow-up, filed as its own issue |
| Actions cache | Stays under the 10 GB per-repository default, which GitHub does not charge for |
| Artifacts | Stay, with short retention. Moving them to S3 is a follow-up only if storage reaches a charge |
| GHCR packages | Retired for CI images. ECR Public replaces them |

### 11. The Terraform stack

`infra/stacks-new/ci-runners` holds everything above in its own state:
the network, the image pipeline, the scaler, the warm pools, the limits, the
IAM, the alarms, the budget, and the log retention. It pins the AWS provider
at `~> 6.33`, which the module requires. The other stacks stay on `~> 5.0`.

The module's Lambda packages are not committed. `infra.yml` runs a stack's
`prepare.sh` before `tofu plan` and `tofu apply`, and the `ci-runners` script
downloads the v7.11.0 release zips and checks each one against a SHA-256
committed beside it.

The first apply runs on a GitHub-hosted runner, as every apply does today.
`infra.yml` moves to our runners after the pools are proven. The runbook
keeps the laptop apply path for a day when GitHub itself is down.

## Alternatives considered

### actions-runner-controller on EKS

ARC runs runners as Kubernetes pods and scales them with a listener per scale
set. It starts a pod in 5 to 10 seconds when a node is free, and a node takes
45 to 90 seconds when Karpenter must add one. It loses on three counts.

- **Ops load.** EKS is a cluster to upgrade on Amazon's schedule (about every
  14 months for standard support), plus Karpenter, the controller, and their
  add-ons. The module's moving parts are API Gateway, Lambda, SQS, and EC2,
  which have no versions to upgrade.
- **Service containers.** Our jobs use `container:` and `services:`. ARC
  serves them either with privileged Docker-in-Docker pods or with its
  Kubernetes container mode, which needs a persistent volume per job and
  routes services differently from GitHub's Docker networking.
- **Cost.** The control plane costs $73 a month before any job runs. Packing
  several jobs onto one node saves boot time, but the module's warm pool
  covers the same need.

### AWS CodeBuild-hosted runners

CodeBuild needs no fleet to run. At 8 vCPUs it costs about $15 to $20 per
1,000 minutes, five to eight times the spot price below, and its concurrency
quota starts low.

### RunsOn

RunsOn runs ephemeral EC2 runners in our account with a commercial licence and
a CloudFormation stack. Its start times are good. It loses on licence and on
being outside our Terraform.

### GitHub-hosted larger runners

8-core runners would end the out-of-memory failures at $0.014 (arm64) to
$0.022 (x64) a minute. They leave the billing lock and the concurrency limit
in place.

## Cost estimate

Prices for `us-east-1` on 2026-10-01. Spot prices are the range across zones
that day. Each runner also pays for its disk ($0.08 per GB-month of gp3) and
its public address ($0.005 an hour).

| Runner | Our cost per 1,000 job-minutes | GitHub's price per 1,000 minutes |
|---|---|---|
| 8 vCPU, 32 GB, arm64, spot | $2.16 to $3.84 | $14.00 (8-core arm64) |
| 8 vCPU, 32 GB, arm64, on-demand fallback | $5.40 to $6.25 | $14.00 |
| 8 vCPU, 32 GB, x64, spot | $2.36 to $4.57 | $22.00 (8-core x64) |
| 2 vCPU, 8 GB, arm64, spot | $0.61 to $1.18 | $5.00 (2-core arm64) |

**Volume.** The baseline gives about 14,700 `CI` job-minutes a day on 2-core
runners and at least 2,100 jobs a day from the small workflows. Each runner
also boots for about one minute and shuts down for about twenty seconds, which
a hosted runner does not bill.

**Our runners, per month, at today's volume:**

| Item | Estimate |
|---|---|
| Large runners: 75% of `CI` minutes plus boot time, about 14,400 instance-minutes a day | $1,200 |
| Small runners: the rest of `CI` and the small workflows, about 8,000 instance-minutes a day | $180 |
| Warm pool idle time, from fully used to never used | $0 to $1,700 |
| Lambda, API Gateway, SQS, CloudWatch Logs, Image Builder, AMI snapshots | $120 |
| Total | $1,500 to $3,200 |

This assumes jobs take as long on 8 vCPUs as on 2, which overstates the cost.

**GitHub-hosted at the same volume:** about 504,000 billed minutes a month
(GitHub rounds each job up to a whole minute). On 2-core runners that is
$3,024, less the 50,000 minutes the Enterprise plan includes, or about $2,700,
on machines that run out of memory. On 8-core x64 runners for the heavy
three quarters, it is about $8,300.

The proof run in the final pull request replaces these estimates with
measured cost per 1,000 job-minutes.

## Consequences

- **Spot interruptions.** AWS can reclaim a spot runner mid-job, and the job
  fails. `price-capacity-optimized` picks the pools least likely to be
  reclaimed, and the termination watcher records each interruption as a
  metric. The PR watcher reruns a failed job as it does today.
- **Image upkeep.** The daily image picks up OS patches and new CI images.
  Bumping the runner agent or the module is a pull request.
- **New failure points.** If the webhook or the scale-up Lambda fails, jobs
  queue. The alarms name each case, and setting `CI_RUNNERS` to `github`
  restores service within one run.
- **Quotas.** On 2026-10-01 the agent asked AWS for 2,400 spot vCPUs, 1,000
  on-demand vCPUs, and 1,000 Lambda concurrent executions. The pools cannot
  reach their maximums until AWS approves.
- **`fleet-capacity`.** Its label stays unserved, as before. Its 24-hour hold
  does not suit spot runners. Serving it is its own decision.
- **Stella.** `macanderson/stella` sits on a personal account, which an
  organization's runners cannot serve. It stays on GitHub-hosted runners.
