# CI runners

CI for every private `oxageninc` repository runs on ephemeral EC2 runners in
AWS account 916294258235 (ADR-246). Each runner takes one job and terminates.
`infra/stacks-new/ci-runners` holds all of it, and `infra.yml` applies it on
merge.

## Pools

A workflow picks a pool by its one label.

| Label | Arch | Size | Warm runners | Max | Network |
|---|---|---|---|---|---|
| `oxagen-large-arm64` | arm64 | 16 vCPU, 64 to 128 GB | 0 | 22 | CI VPC |
| `oxagen-large-x64` | x64 | 16 vCPU, 64 to 128 GB | 6 | 22 | CI VPC |
| `oxagen-small-arm64` | arm64 | 4 vCPU, 16 GB | 0 | 36 | CI VPC |
| `oxagen-small-x64` | x64 | 4 vCPU, 16 GB | 10 | 36 | CI VPC |
| `oxagen-deploy` | arm64 | 16 vCPU, 64 GB | 1 | 6 | production VPC |

`pipeline.yml` sends `checks`, `unit`, `e2e`, `rls-integration`, and
`rds-compatibility` to `oxagen-large-<arch>`, `build` and the light jobs to
`oxagen-small-<arch>`, and every production job to `oxagen-deploy`. The
repository variables choose: `CI_RUNNERS=aws` turns our runners on,
`CI_RUNNER_ARCH` picks `x64` (the default) or `arm64`, `CI_HEAVY_POOL=small`
sends the heavy jobs to the small pool, and `CI_IMAGE_REGISTRY` points the
toolchain and service images at ECR Public (`public.ecr.aws/z5z6u7g2`).

`locals.pools` in `runners.tf` lists each pool's instance types in priority
order. In `terraform.tfvars`, `warm_pool` sets the warm sizes and
`max_runners` sets the maximums. The warm pools stay at zero while
`github_app_ready` is `false`.

Only jobs that declare `environment: production` ask for `oxagen-deploy`, and
the `oxagen-production` runner group admits only the workflows listed in
`scripts/runner-groups.sh`, at `refs/heads/main`. A production job dispatched
from another branch waits for a runner that never comes. Dispatch from `main`.

`infra.yml`'s apply job runs on `oxagen-deploy` too. If the runners are down,
roll back with `CI_RUNNERS` first, and the apply that repairs them runs on a
GitHub-hosted runner.

## The EC2 quota

On 2026-10-01 AWS approved 300 spot and 300 on-demand vCPUs, with the cases
for 2,400 and 1,000 still open. That holds about 37 large runners or 150
small ones at once. Mac chose speed over concurrency, so the heavy jobs use
the large pool. When a burst needs more runners than the quota holds, the
fleet fails over from spot to on-demand and then queues, and the queue-age
and vCPU alarms fire. To trade speed for concurrency during a crunch, set
`CI_HEAVY_POOL=small`, and delete it afterwards.

The deploy pool and production run on on-demand only. `max_runners` caps the
CI pools at 496 vCPUs, so they never take the last 104 on-demand vCPUs: 96
for the deploy pool's 6 runners and 8 for production. `terraform.tfvars`
shows the arithmetic. When AWS raises a quota, raise the caps by the same
number of vCPUs, or the new quota sits unused.

## Roll back to GitHub-hosted runners

Set the repository variable to `github`:

```sh
gh variable set CI_RUNNERS --repo oxageninc/product --body github
```

Every moved job reads `vars.CI_RUNNERS` in its `runs-on`, so the next run of
each workflow goes to GitHub-hosted runners. Runs already queued keep their
labels. Cancel and rerun them. Set the variable back to `aws` to return.

For the other private repositories, set the organization variable of the same
name: `gh variable set CI_RUNNERS --org oxageninc --visibility private --body github`.

## Drain

Stop new runners without an apply by setting each scale-up and pool Lambda's
reserved concurrency to zero:

```sh
for pool in oxagen-large-arm64 oxagen-large-x64 oxagen-small-arm64 oxagen-small-x64 oxagen-deploy; do
  aws lambda put-function-concurrency --function-name "ci-$pool-scale-up" --reserved-concurrent-executions 0
  aws lambda put-function-concurrency --function-name "ci-$pool-pool" --reserved-concurrent-executions 0 || true
done
```

Running jobs finish. Idle runners terminate within 30 minutes, or at once:

```sh
aws ec2 describe-instances --filters "Name=tag:ghr:environment,Values=ci-oxagen-*" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 terminate-instances --instance-ids <ids>
```

To undo the drain, remove the reservation, which is how Terraform leaves it:
`aws lambda delete-function-concurrency --function-name <name>` for each
function above. Roll back with `CI_RUNNERS` first if jobs must keep running.

## Rebuild the runner image

Image Builder rebuilds both images at 07:00 UTC every day. A build downloads
`image/` from the assets bucket when it starts, and every `infra` apply of
this stack uploads those files again from the commit being applied. Start a
build by hand only when no `infra` run is in progress, or a run applying an
older commit can replace the files under it (2026-10-01, build 4). To build
now:

```sh
for arn in $(aws imagebuilder list-image-pipelines --query "imagePipelineList[?starts_with(name, 'oxagen-ci-runner-')].arn" --output text); do
  aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$arn"
done
```

A build takes 20 to 40 minutes. When it finishes, Image Builder writes the new
AMI id to `/imagebuilder/oxagen-ci-runner/arm64` and `/imagebuilder/oxagen-ci-runner/x64`,
and the next runner launches from it. Build logs are in the
`/aws/imagebuilder/oxagen-ci-runner` log group and under `logs/` in
`s3://oxagen-ci-runners-916294258235`.

To roll an image back, point the parameter at an older AMI:

```sh
aws ec2 describe-images --owners self --filters "Name=tag:ImageFamily,Values=oxagen-ci-runner" "Name=tag:Architecture,Values=arm64" \
  --query 'sort_by(Images,&CreationDate)[].[ImageId,CreationDate]' --output text
aws ssm put-parameter --name /imagebuilder/oxagen-ci-runner/arm64 --type String --data-type aws:ec2:image --overwrite --value <ami-id>
```

The next scheduled build overwrites it. Set the pipeline's status to
`DISABLED` in `image.tf` to hold an image longer.

## How a runner starts

`ci-start-runner.service` runs the module's start script once the network is
up, about 25 seconds into boot. The script reads its pool's settings from the
instance tags and Parameter Store, registers with a JIT config, runs one job,
and terminates the instance. Docker starts beside it. The image does not use
cloud-init's per-boot directory, because Image Builder's cleanup empties
`/var/lib/cloud`. Node is on the `PATH` (`/usr/local/bin`) and in the tool
cache. A runner that does not register within 5 minutes is removed by
scale-down.

## Create the GitHub App

Done once, by an organization owner.

1. Open `infra/stacks-new/ci-runners/scripts/github-app-manifest.html` in a
   browser and press the button.
2. On GitHub, press "Create GitHub App for oxageninc".
3. GitHub sends you to oxagen.sh with `?code=...` in the address bar. Within
   the hour, run `infra/stacks-new/ci-runners/scripts/store-github-app.sh <code>`.
   It writes the App's id, private key, and webhook secret to Parameter Store
   under `/oxagen/ci-runners/github-app/`, and prints the install link.
4. Install the App on `oxageninc` with "Only select repositories", and select
   every private repository. Never select a public one.
5. Set `github_app_ready = true` in `terraform.tfvars` and merge, so the warm
   pools fill.

## Rotate the GitHub App's key

1. In the App's settings on GitHub, generate a new private key. GitHub
   downloads a `.pem` file.
2. Store it, then delete the file:

   ```sh
   aws ssm put-parameter --name /oxagen/ci-runners/github-app/key_base64 --type SecureString --overwrite \
     --value "$(base64 < ~/Downloads/oxagen-ci-runners.*.private-key.pem | tr -d '\n')"
   rm ~/Downloads/oxagen-ci-runners.*.private-key.pem
   ```

3. Start new Lambda instances so none keeps the old key in memory. A
   configuration change does that:

   ```sh
   for f in $(aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'ci-oxagen-') || FunctionName=='ci-webhook'].FunctionName" --output text); do
     aws lambda update-function-configuration --function-name "$f" --description "App key rotated $(date -u +%F)" >/dev/null
   done
   ```

4. Delete the old key in the App's settings.

To rotate the webhook secret, generate one (`openssl rand -hex 32`), write it to
`/oxagen/ci-runners/github-app/webhook_secret`, set the same value in the App's
webhook settings, and run step 3. Deliveries in the gap fail. Redeliver them
from the App's "Advanced" tab.

## Runner groups

`scripts/runner-groups.sh` creates or updates both groups. Run it again after
creating a private repository, because `oxagen-ci` lists the private
repositories by id. Add the repository to the App's installation and to
`private_repositories` in `terraform.tfvars` too.

## Alarms

Every alarm emails `alarm_email` through the `oxagen-ci-runners-alarms` SNS
topic. Confirm the subscription email once after the first apply.

| Alarm | Meaning | First step |
|---|---|---|
| `ci-runners-<pool>-queue-age` | A job has waited more than 2 minutes for 5 minutes | Read the pool's scale-up log group, `/aws/lambda/ci-<pool>-scale-up`, where `<pool>` is the label. A quota or capacity error names itself there |
| `ci-runners-<pool>-dead-letters` | A job event failed scale-up 3 times and left the queue | Same log group. Rerun the job once the cause is fixed. The event in `ci-<pool>-queued-builds_dead_letter` shows which job |
| `ci-runners-<pool>-scale-up-errors` | The scale-up Lambda threw 3 or more times in 5 minutes | Same log group. `Bad credentials` means the App's key is wrong. `VcpuLimitExceeded` means a quota |
| `ci-runners-webhook-errors` | GitHub's events are not reaching the queues | `/aws/lambda/ci-webhook`. `signature` errors mean the webhook secret differs between GitHub and Parameter Store |
| `ci-runners-webhook-5xx` | API Gateway answered GitHub with 5xx | The same log group, and the App's "Advanced" tab for failed deliveries |
| `ci-runners-image-build-failed` (an EventBridge rule, not an alarm) | A runner image failed to build | The `/aws/imagebuilder/oxagen-ci-runner` log group. Runners keep the previous image |

| `ci-runners-<spot or on-demand>-vcpu-near-quota` | Running vCPUs passed 80% of the EC2 quota for 5 minutes | Compare busy runners with instances: `gh api orgs/oxageninc/actions/runners --paginate --jq '[.runners[] \| select(.busy)] \| length'` against the instance count above. Busy close to instances means real demand, so raise the quota. Many instances and few busy runners means machines that boot and never register: drain the pools, read one instance's console (`aws ec2 get-console-output --latest`), and fix the image |

The AWS Budget `ci-runners-monthly` emails at 80% and 100% of actual spend and
at 100% of forecast spend.

## Runners that never register

The runner registers with a JIT config made at launch, so GitHub lists a
booting runner as `offline`. The pool Lambda counts only idle online runners,
so a runner that takes longer than the pool's 2-minute interval to come
online is launched again. On 2026-10-01 a broken image did that to 121
machines in 15 minutes. Drain the pools as above whenever the image is
suspect, and resume them once a runner registers in under a minute.

## A job that waits

1. Check the label. A job runs only on a pool whose label equals its whole
   `runs-on` set.
2. Read the pool's queue: `aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name ci-<pool>-queued-builds --query QueueUrl --output text) --attribute-names All`.
3. Read the scale-up log group for that pool.
4. Find the runner: `aws ec2 describe-instances --filters "Name=tag:ghr:environment,Values=ci-<pool>"`.
   Its start log is in the pool's runner log groups, and in `/var/log/runner-startup.log` on the instance.

## Quotas

On 2026-10-01 the account asked AWS for 2,400 spot vCPUs (case 179087953200188),
1,000 on-demand vCPUs (case 179087953200380), and 1,000 Lambda concurrent
executions (case 179087937100665). The 16-vCPU pools need about 5,000 spot and
3,000 on-demand vCPUs at their ceilings. File the next increase once a case
closes, because AWS takes one open request per quota.
