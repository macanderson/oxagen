# CI runners

CI for every private `oxageninc` repository runs on ephemeral EC2 runners in
AWS account 916294258235 (ADR-246). Each runner takes one job and terminates.
`infra/stacks-new/ci-runners` holds all of it, and `infra.yml` applies it on
merge.

## Pools

A workflow picks a pool by its one label.

| Label | Arch | Size | Warm runners | Max | Network |
|---|---|---|---|---|---|
| `oxagen-large-arm64` | arm64 | 16 vCPU, 32 to 128 GB | 30 | 250 | CI VPC |
| `oxagen-large-x64` | x64 | 16 vCPU, 32 to 64 GB | 10 | 100 | CI VPC |
| `oxagen-small-arm64` | arm64 | 4 vCPU, 8 to 16 GB | 20 | 150 | CI VPC |
| `oxagen-small-x64` | x64 | 4 vCPU, 16 GB | 4 | 50 | CI VPC |
| `oxagen-deploy` | arm64 | 4 vCPU, 16 GB | 1 | 6 | production VPC |

`locals.pools` in `runners.tf` lists each pool's instance types in priority
order, and `warm_pool` in `terraform.tfvars` sets the warm sizes. The warm
pools stay at zero while `github_app_ready` is `false`.

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

Image Builder rebuilds both images at 07:00 UTC every day. To build now:

```sh
for arn in $(aws imagebuilder list-image-pipelines --query "imagePipelineList[?starts_with(name, 'oxagen-ci-runner-')].arn" --output text); do
  aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$arn"
done
```

A build takes 20 to 40 minutes. When it finishes, Image Builder writes the new
AMI id to `/imagebuilder/oxagen-ci-runner/arm64` and `/imagebuilder/oxagen-ci-runner/x64`,
and the next runner launches from it. Build logs are in the
`/oxagen/ci-runners/image-builds` log group and under `logs/` in
`s3://oxagen-ci-runners-916294258235`.

To roll an image back, point the parameter at an older AMI:

```sh
aws ec2 describe-images --owners self --filters "Name=tag:ImageFamily,Values=oxagen-ci-runner" "Name=tag:Architecture,Values=arm64" \
  --query 'sort_by(Images,&CreationDate)[].[ImageId,CreationDate]' --output text
aws ssm put-parameter --name /imagebuilder/oxagen-ci-runner/arm64 --type String --data-type aws:ec2:image --overwrite --value <ami-id>
```

The next scheduled build overwrites it. Set the pipeline's status to
`DISABLED` in `image.tf` to hold an image longer.

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
| `ci-runners-image-build-failed` (an EventBridge rule, not an alarm) | A runner image failed to build | The `/oxagen/ci-runners/image-builds` log group. Runners keep the previous image |

The AWS Budget `ci-runners-monthly` emails at 80% and 100% of actual spend and
at 100% of forecast spend.

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
