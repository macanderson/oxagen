# CI runners

Every CI job in `oxageninc/product` runs on a standard GitHub-hosted runner:
`ubuntu-latest`, `ubuntu-slim`, `ubuntu-24.04-arm`, `windows-latest`, or a
macOS runner. Standard runners are free for a public repository, so the
repository went public and the AWS runner pools of ADR-246 were removed
(#5218).

Do not add a larger runner (a label with `-large`, `-xlarge`, or a core
count) or a self-hosted label. Larger runners bill per minute even on a
public repository.

## CI images

The jobs run inside two toolchain images, and their service containers come
from mirrored images. All of them live in ECR Public under
`public.ecr.aws/z5z6u7g2`, and anyone can pull them without signing in.

| Image | What it holds |
|---|---|
| `oxagen-ci-base` | Node, pnpm, Atlas, psql. Every job that is not e2e runs in it. |
| `oxagen-ci-e2e` | `oxagen-ci-base` plus Playwright's Chromium. |
| `mirror/postgres`, `mirror/clickhouse-server`, `mirror/neo4j` | Copies of the Docker Hub images in `infra/stacks-new/ci-runners/service-images.json`. |

`ci-image.yml` builds and pushes them on `main` and every day at 05:00 UTC. It
assumes the `gha-ci-image` role. `infra/stacks-new/ci-runners` holds the
repositories and the role, and `infra.yml` applies the stack on merge. The
stack keeps its old name so its Terraform state stays where it is.

## A job that lost its runner

A job whose log ends with `The runner has received a shutdown signal` lost its
runner mid-job. `rerun-lost-runner.yml` reruns the lost job and the jobs that
depend on it once the CI run finishes. If the workflow missed a run, dispatch
it with the run id:

```sh
gh workflow run rerun-lost-runner.yml --repo oxageninc/product -f run_id=<run id>
```

## The removed AWS pools

ADR-246 describes the five pools (`oxagen-large-*`, `oxagen-small-*`,
`oxagen-deploy`), their scaler, and the daily runner AMI. This runbook covered
them until #5219 removed them. Read it in the git history if the pools come back.
