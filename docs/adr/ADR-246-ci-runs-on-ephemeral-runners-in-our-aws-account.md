# ADR-246: CI runs on ephemeral runners in our AWS account

- **Status:** Accepted. Mac set the direction on 2026-10-01: self-hosted,
  ephemeral, autoscaling runners in our AWS account, no dependency on GitHub
  billing wherever possible, and speed before cost. The scaler choice, the
  runner sizes, and the network layout are the agent's, recorded here for
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
billing wherever that is possible, and approved the AWS spend that takes. Mac
then set speed as the first priority: "I want my CI to be lightning fast. I
don't care about cost at the moment." So the sizes below favor the fastest
machine and the shortest wait, and the cost section records what that costs.

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

| Label | Arch | Size | Instance types, in priority order | Capacity | Max | Network |
|---|---|---|---|---|---|---|
| `oxagen-large-arm64` | arm64 | 16 vCPU, 32 to 128 GB | m8gd, c8gd, m7gd, m8g, c8g, r8g, m7g `.4xlarge` | spot, on-demand on failure | 250 | CI VPC |
| `oxagen-large-x64` | x64 | 16 vCPU, 32 to 64 GB | m7a, c7a, m6id, m7i, c7i, m6a `.4xlarge` | spot, on-demand on failure | 100 | CI VPC |
| `oxagen-small-arm64` | arm64 | 4 vCPU, 8 to 16 GB | m8gd, m7gd, m8g, c8g, m7g `.xlarge` | spot, on-demand on failure | 150 | CI VPC |
| `oxagen-small-x64` | x64 | 4 vCPU, 16 GB | m7a, m6id, m7i, m6a `.xlarge` | spot, on-demand on failure | 50 | CI VPC |
| `oxagen-deploy` | arm64 | 4 vCPU, 16 GB | m8g, m7g, m8gd `.xlarge` | on-demand | 6 | production VPC |

- **Speed.** The heavy jobs (`build`, `unit`, `e2e`, `checks`) get 16 vCPUs,
  eight times a hosted runner's 2. The first types in each list have local
  NVMe (the `d` types), and on those a boot service puts the job workspace and
  Docker's volumes on it before Docker starts. Graviton4 (`m8g`, `c8g`) and
  AMD Zen 4 (`m7a`, `c7a`) give one physical core per vCPU. The root volume is
  gp3 at 16,000 IOPS and 1,000 MB/s on the large pools and 6,000 IOPS and
  500 MB/s on the small ones.
- **Labels.** Each configuration carries one label and no default labels, and
  matches a job only when the job's label set equals it
  (`bidirectionalLabelMatch`). A job that asks for
  `[self-hosted, linux, fleet-capacity]` starts nothing.
- **Arch.** Graviton runs any job that works on arm64. The two x64 pools run
  the rest. The pilot runs on `oxagen-large-x64`, because the CI images on
  2026-10-01 are amd64 only. Jobs move to arm64 once `ci-image.yml` has
  published the multi-arch images.
- **Spot.** Every CI pool requests spot with `capacity-optimized-prioritized`,
  which asks for the fastest types first and moves down the list when capacity
  is short. When spot capacity or the spot quota runs out, the same Lambda call
  falls back to on-demand (`enable_on_demand_failover_for_errors`). Spot and
  on-demand have separate quotas, so using both raises the number of runners
  the account can hold at once.
- **Ceiling.** At their maximums the pools hold 556 runners. A peak of 300
  jobs (200 large, 100 small) needs about 3,600 vCPUs, and the warm pools add
  about 740.
- **Deploy.** `oxagen-deploy` runs every job that touches production:
  `migration-gate`, `deploy-node`, `deploy-web`, `manual-app-deploy`,
  `db-migrate.yml`, `store-migrate.yml`, and the `infra.yml` apply. It has its
  own instance role, its own runner group, and its own Parameter Store path,
  so a pull request's job cannot read a deploy runner's registration.

### 3. Start time

- **Warm pool.** Each pool keeps idle runners through `pool_config`, topped up
  every minute, and sized 0 until the GitHub App exists. The sizes after
  cut-over are 30 `oxagen-large-arm64`, 10 `oxagen-large-x64`, 20
  `oxagen-small-arm64`, 4 `oxagen-small-x64`, and 1 `oxagen-deploy`, around
  the clock. A warm runner lives 30 minutes idle before scale-down replaces it.
- **No webhook delay.** `delay_webhook_event` is 0. The module default of 30
  seconds would spend half of the 60-second queue target before scale-up even
  starts. When a warm runner takes the job first, the extra runner waits for
  the next job.
- **No EventBridge hop.** The webhook dispatches straight to the pool's SQS
  queue.
- **No concurrency cap.** The scale-up and pool Lambdas reserve no
  concurrency, so a burst of 300 jobs is limited only by the account's Lambda
  concurrency, which needs raising from 10 first.
- **Retry.** If a job is still queued 2 minutes after its runner was started,
  the job-retry Lambda queues it again, up to twice.
- **Image.** The image carries the runner agent, Docker, Node, the pnpm store,
  and every container image a job pulls, so a cold runner downloads nothing
  large before its job.

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
  with its own security group, which nothing admits yet. The Aurora security
  group declares its rules inline, so the `oxagen` stack, not this one, adds
  the rule that admits the deploy group on port 5432. A rule added from another
  stack would be deleted by the next `oxagen` apply. ClickHouse and Neo4j
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
- Node at the `.node-version` pin in the runner's tool cache, and the pnpm
  store `ci-image.yml` publishes to S3 for that architecture.
- the boot service that moves the workspace and Docker's volumes to local NVMe.

Image Builder components and recipes are immutable, so one fixed component
downloads `image/` from S3 and runs `provision.sh`. A change to the script
reaches the next build without replacing a recipe.

Image Builder writes each new AMI's id to `/imagebuilder/oxagen-ci-runner/<arch>`
in Parameter Store. That is the only prefix its service-linked role may write.
The scale-up Lambda reads the parameter on every launch, so a new image takes
effect without a Terraform apply. Image Builder keeps the newest three AMIs
per architecture and deletes the rest.

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
- **GitHub App.** Mac creates the App once from a manifest
  (`scripts/github-app-manifest.html`), which fixes its permissions: Self-hosted
  runners read and write on the organization, and Actions, Checks, and
  Metadata read on repositories, with the `workflow_job` event.
  `scripts/store-github-app.sh` exchanges the manifest code and writes the id,
  private key, and webhook secret to Parameter Store under
  `/oxagen/ci-runners/github-app/` without the key touching a file. This prefix
  sits outside `/oxagen/ci` on purpose: ADR-240 gives workflow roles read
  access to `/oxagen/ci`, and no workflow may read the App's key.
- **Webhook address.** The App posts to `https://ci-webhook.oxagen.sh/webhook`,
  a custom domain on the module's API Gateway, so the App never needs editing
  when the gateway is replaced.
- **Private repositories only.** Mac installs the App on the private
  repositories alone, so a public repository's jobs never reach the webhook.
  The module's `repository_white_list` repeats that list. The `oxagen-ci`
  runner group lists the private repositories by id and refuses public ones.
  GitHub accepted the `private` visibility on 2026-10-01 and stored `all`, so
  `scripts/runner-groups.sh` rebuilds the list from the organization's private
  repositories each time it runs.
- **Production group.** The `oxagen-production` runner group admits
  `oxageninc/product` alone, and only these workflows at `refs/heads/main`:
  `pipeline.yml`, `db-migrate.yml`, `store-migrate.yml`, and `infra.yml`. A
  pull request's run uses its merge ref, so it cannot land on a deploy runner.

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
- **Image build.** An EventBridge rule forwards a failed Image Builder build,
  which Image Builder reports as an event, not a metric.
- **Budget.** An AWS Budget of $20,000 a month on the `Stack` tag alerts Mac by
  email at 80% and 100% of actual spend and 100% of forecast spend. The stack
  activates `Stack` as a cost allocation tag, and the module puts it on every
  runner instance and volume.
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
The runner groups are not Terraform resources, because the stack has no GitHub
credential at plan time. `scripts/runner-groups.sh` creates and updates them,
and is their record.
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

Prices for `us-east-1` on 2026-10-01. Spot prices are the range across the
zones and types in each pool that day. Each runner also pays for its root
volume (gp3 storage plus the IOPS and throughput above the free baseline) and
its public address ($0.005 an hour). The large pools' 16,000 IOPS and
1,000 MB/s cost about $0.15 an hour per volume.

| Runner | Our cost per 1,000 job-minutes | GitHub's price per 1,000 minutes |
|---|---|---|
| 16 vCPU, arm64, spot | $6.60 to $17.80 | $26.00 (16-core arm64) |
| 16 vCPU, arm64, on-demand fallback (`m8g.4xlarge`) | $14.60 | $26.00 |
| 16 vCPU, x64, spot | $6.90 to $13.00 | $42.00 (16-core x64) |
| 4 vCPU, arm64, spot | $1.90 to $3.70 | $8.00 (4-core arm64) |

**Volume.** The baseline gives about 14,700 `CI` job-minutes a day on 2-core
runners and at least 2,100 jobs a day from the small workflows. Each runner
also boots for about one minute and shuts down for about twenty seconds, which
a hosted runner does not bill.

**Our runners, per month, at today's volume:**

| Item | Estimate |
|---|---|
| Large runners: 75% of `CI` minutes plus boot time, about 14,400 instance-minutes a day | $3,700 |
| Small runners: the rest of `CI` and the small workflows, about 8,000 instance-minutes a day | $600 |
| Warm pools' idle time, from always busy to never used | $0 to $17,900 |
| Lambda, API Gateway, SQS, CloudWatch Logs, Image Builder, AMI snapshots | $150 |
| Total | $4,450 to $22,350 |

The large-runner line assumes jobs take as long on 16 vCPUs as on 2, which
overstates it. The warm-pool line is the widest: 65 idle runners cost about
$24 an hour, and each job that lands on one turns idle time into work. The
budget alert sits at $20,000 so that it flags a runaway, not the expected
spend.

**GitHub-hosted at the same volume:** about 504,000 billed minutes a month
(GitHub rounds each job up to a whole minute). On 2-core runners that is
$3,024, less the 50,000 minutes the Enterprise plan includes, or about $2,700,
on machines that run out of memory. On 16-core runners for the heavy three
quarters, it is about $9,600 (arm64) to $14,900 (x64), and the billing lock
and the concurrency limit stay.

The proof run in the final pull request replaces these estimates with
measured cost per 1,000 job-minutes.

## Consequences

- **Spot interruptions.** AWS can reclaim a spot runner mid-job, and the job
  fails. `capacity-optimized-prioritized` weighs capacity as well as priority,
  and the termination watcher records each interruption as a metric. A
  10-minute job on a pool that AWS reclaims less than 5% of the time in a month
  meets an interruption about once in 40,000 jobs. The PR watcher reruns a
  failed job as it does today.
- **Image upkeep.** The daily image picks up OS patches and new CI images.
  Bumping the runner agent or the module is a pull request.
- **New failure points.** If the webhook or the scale-up Lambda fails, jobs
  queue. The alarms name each case, and setting `CI_RUNNERS` to `github`
  restores service within one run.
- **Quotas.** On 2026-10-01 the agent asked AWS for 2,400 spot vCPUs, 1,000
  on-demand vCPUs, and 1,000 Lambda concurrent executions. AWS opened a support
  case for each, and allows one open request per quota. The 16-vCPU pools need
  about 5,000 spot and 3,000 on-demand vCPUs at their ceilings, which is the
  next request. Until then the fleets stop at the quota and fall back to
  on-demand, and the queue-age alarm names any wait.
- **`fleet-capacity`.** Its label stays unserved, as before. Its 24-hour hold
  does not suit spot runners. Serving it is its own decision.
- **Stella.** `macanderson/stella` sits on a personal account, which an
  organization's runners cannot serve. It stays on GitHub-hosted runners.

## Amendment of 2026-10-01: what the build changed

CI moved to these runners at 23:36Z on 2026-10-01 (`CI_RUNNERS=aws`). These
facts from the build supersede the matching parts of the decisions above.

- **Quota.** AWS approved 300 spot and 300 on-demand vCPUs and 1,000 Lambda
  concurrent executions. The EC2 cases for 2,400 and 1,000 stay open. The
  account holds about 37 large runners or 150 small ones at once.
- **Speed over concurrency.** Mac chose speed. The heavy jobs run on the
  16-vCPU pool and ten of those stay warm. `CI_HEAVY_POOL=small` sends them to
  the 4-vCPU pool when concurrency matters more.
- **Warm pools.** 10 large x64, 10 small x64, and 1 deploy. The arm64 pools
  keep none until a job is proven on arm64. The pools top up every 2 minutes.
  GitHub lists a JIT-registered runner as `offline` until it connects, and the
  module's pool Lambda does not count an offline runner, so a pool that tops
  up faster than runners register keeps launching.
- **Start path.** A systemd unit, `ci-start-runner.service`, starts the
  runner once the network is up, about 25 seconds into boot. Image Builder's
  cleanup empties cloud-init's per-boot directory, so the module's own
  approach does not survive it. The unit does not wait for Docker.
- **No EBS initialization rate.** EBS caps the combined provisioned
  initialization rate across volumes created at once. At 300 MiB/s per
  volume, a burst of 100 runners failed to launch. The provider keeps the
  rate in a launch template when the attribute is removed, so the agent
  created launch template versions without it.
- **Image paths.** Image Builder writes the AMI id under `/imagebuilder/`
  and its logs under `/aws/imagebuilder/`, the only places its service-linked
  role reaches.
- **Rollback switch.** `CI_IMAGE_REGISTRY` joins `CI_RUNNERS`: unset, the
  workflows pull the old public GHCR images and Docker Hub.
- **Merge gate.** The `main` ruleset had no bypass actor after the move to
  the organization, so no PR could merge while `Brand drift` failed inside
  `checks`. Mac approved an organization-admin bypass on 2026-10-01.

### Measured

| Measure | Value |
|---|---|
| Burst | 100 jobs on `oxagen-small-x64` (run 36944117774), 100 succeeded, 100 running at once |
| Queue time, all cold starts | p50 65 s, p95 78 s, max 78 s |
| Teardown | 100 of 100 runners terminated after their job |
| Runner start after launch | 24 to 42 seconds of uptime |
| Compute per 1,000 job-minutes | $3.09 (instance time, 51% spot), against $12 for GitHub's 4-core runner |
| A ready PR, idle system, 4-vCPU runners | 12 to 14 minutes, set by the slowest `unit` lane |

The p95 of 78 seconds is for a burst larger than the warm pool, where every
job waits for a new machine. A job that finds a warm runner starts in
seconds.

## Amendment of 2026-10-02: pool caps and smaller build runners

The first four hours on these runners (2026-10-01 23:36Z to 2026-10-02
03:15Z) changed three settings (#5070). These facts supersede the matching
parts above.

- **Both quotas filled.** During every backlog, spot use sat at its 300-vCPU
  quota and on-demand use sat near its own 300. Only 15 to 20 large runners
  ran jobs at once while 50 to 100 jobs waited. Jobs ran 2 to 5 times faster
  than on GitHub's runners, but a full pull request still took a median 21
  minutes.
- **Deploys starved.** The deploy pool runs on on-demand only, and the CI
  pools had taken that quota. Its scale-up failed with `VcpuLimitExceeded`
  161 times in four hours, and `deploy oxagen.sh` waited a median 8.1 minutes
  for a runner, against 0.1 before. `max_runners` in `terraform.tfvars` now
  caps the CI pools at 496 vCPUs combined (22 large, 36 small). While spot
  is at its quota, that leaves 96 on-demand vCPUs for the deploy pool and 8
  for production. When spot capacity runs short instead, CI can take more
  on-demand and the reserve shrinks.
- **Build lanes on the small pool.** The three `build` lanes move to
  `oxagen-small-<arch>`. Each finished in under 2 minutes on a 16-vCPU runner
  and in 2 to 3 minutes on a 4-vCPU one, well inside `unit (app)`. Each move
  frees 12 vCPUs for the jobs that use 16.
- **Six warm large runners.** With #5056, which moves `rls-integration` and
  `rds-compatibility` to the small pool, the large pool serves six jobs per
  pull request (`checks`, `e2e`, and four `unit` lanes). Six stay warm
  instead of ten.

Raise `max_runners` when AWS approves the open quota cases.
