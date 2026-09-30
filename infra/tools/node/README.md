# Node deployment

The shared application node runs these scripts. Infrastructure publishes a
complete bundle under `_node-tools/releases/<digest>.json`. The digest covers
the five allowed filenames and each file's UTF-8 content hash. The dispatcher
refuses missing files, extra paths, changed content, and symlinks in cached
releases. It does not extract an archive.

The deployment document embeds the trusted dispatcher from infrastructure
source. Application CI asks that document to verify its source digest before
publishing a service artifact. An old document rejects the new parameters.
Missing approved bundles fail before the recovery artifact changes. Verification
also checks that the bucket's bootstrap launcher, dispatcher, and current pointer
match the approved release. Actual deployment verifies the bundle again.

The dispatcher installs a complete release at `/opt/oxagen/node-tools/<digest>`
under `service-deploy.lock`, then releases that installation lock before running
the worker through its absolute immutable path. The worker acquires the same
lock for memory admission, container replacement, health checks, and rollback.
Every Python helper comes from the worker's release directory. Updating the
legacy entry points cannot change files used by an active deployment.

Only infrastructure authority publishes `_node-tools` and bootstrap executables.
Application and Stella deploy roles retain their existing permissions. The
platform role's separate shell permission for database migrations is unchanged.
The existing infrastructure workflow publishes bundles after applying the
production deploy or staging stack. Source changes under `infra/tools/node/`
select those stacks. A deployment that reaches verification before publication
fails closed and can be rerun after infrastructure finishes.

For an explicit infrastructure installation, run `infra/tools/install-node-scripts.sh`.
It publishes the bundle, verifies it, and atomically switches legacy entry points
under the node lock. It retains the existing Caddy validation and rollback flow.
`infra/tools/publish-node-tools.sh` only publishes approved sources and takes an
explicit `BUCKET`. It does not restart a service. Neither script runs with an
application deploy role.

The legacy bootstrap still downloads `_bin/`. Its `deploy-service.sh` is now a
launcher for the approved bundle. No user-data edit is needed. Keep approved S3
bundles and installed node tool releases for rollback and investigation. Service
rollback uses the same guarded worker, never a fallback to an unverified script.
Node configuration remains in `/opt/oxagen/bin/node.env` and is not part of the
executable bundle.

## The contract: `oxagen-run.json`

A deployable artifact is a gzipped tarball named `<service>-standalone.tgz`,
uploaded to `s3://oxagen-deploy-916294258235/_deploy/`, whose root holds a
manifest describing how it runs:

```json
{
  "port": 3001,
  "image": "node:24.21.0-alpine",
  "command": ["node", "website/server.js"],
  "memory": "512m",
  "health_path": "/",
  "env": { "NEXT_TELEMETRY_DISABLED": "1" },
  "config_prefix": "/oxagen/production/stella"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `port` | yes | Loopback port Caddy proxies to. Must match the Caddyfile. |
| `image` | yes | Container image. Must have an `arm64` variant for the Graviton node. |
| `command` | yes | Argv, relative to the tarball root, which is mounted at `/app`. |
| `memory` | no (`512m`) | Hard container limit. Positive integer bytes, or a `k`, `m`, or `g` suffix. |
| `health_path` | no (`/`) | Path polled for up to 60s after start. |
| `env` | no | Non-secret environment. This file ships inside a public CI artifact. |
| `config_prefix` | no | Parameter Store prefix; every parameter under it becomes an environment variable named after its last path segment. |

The manifest is what makes the deploy path generic. Passing the image, port and
command as SSM parameters instead would mean an infrastructure change and a
Terraform apply every time an application changed how it starts, and it would
widen the document's arguments from one validated identifier to a set of
strings that reach a command line.

## Memory budget

Before replacing a container, deployment takes `/opt/oxagen/service-deploy.lock`
and holds it through the health check and rollback. Different services share
this lock. The proxy helper establishes Caddy's 256 MiB hard limit, refusing to
shrink it while its measured usage exceeds 192 MiB.

`memory-budget.py` adds the incoming limit to every other running or restarting
container's limit, plus 1,024 MiB for the kernel, Docker, SSM, CloudWatch, and
other host processes. The replaced service's current and migration-era names
are excluded because deployment removes both before starting the replacement.
Caddy is counted as a container. Swap contributes no capacity.

An unlimited container or a total above physical `MemTotal` refuses deployment
before changing the service's current release or stopping its container. The
error names the missing limit or required physical capacity. Keep the guard in
place and resolve the allocation before retrying. Passing this check establishes
the declared memory budget, not sustained workload throughput.

### Configuration prefix

Secrets in the artifact would mean rebuilding the application to rotate one,
and would put them in a tarball produced by a public CI job. Read at start
instead, a rotation is a parameter write plus a restart.

Each value is exported into the deploy script's environment and passed as
`-e KEY` with no `=`, which tells Docker to copy it from its client. The two
alternatives are both worse: `-e KEY=value` puts every secret into the argv of
`docker run`, readable from `/proc` while the command runs; and `--env-file`
keeps it out of argv but cannot represent a newline at all — its format is
literal `KEY=VALUE` lines with no quoting or escaping, so
`/oxagen/production/GITHUB_APP_PRIVATE_KEY`, which is a PEM, would have had its
first line carried and the rest silently dropped.

None of this hides the values from `docker inspect`, which reports a
container's environment however it was set. That is inherent to configuring a
process through its environment; the control that matters there is that
reaching this instance requires SSM and there is no SSH key.

## Architecture

The node is `arm64`. An artifact built on an x86 runner can carry native
modules that will not load here, and the failure is at first request rather
than at build. Build jobs that produce artifacts for this node must run on an
arm runner (`ubuntu-24.04-arm`).

## Rollback

`deploy-service.sh` keeps the last three releases under
`/opt/oxagen/services/<service>/releases/` with `current` symlinked to the live
one. If the new release does not answer its health check within 60 seconds, the
symlink and the container go back to the previous release — and the script
still exits non-zero, so the SSM command fails and the workflow goes red. A
rollback that reported success would be the worst outcome available: production
quietly serving old code while the merge looks shipped.

Roll back by hand with the release id:

```bash
aws ssm start-session --target "$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=oxagen-app Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
ls /opt/oxagen/services/<service>/releases
```

## The engine service

`stella-serve` is the Stella engine the in-app agent runs on (ADR-053). It
is not built here: the artifact is a manifest naming the published image
`ghcr.io/macanderson/stella-serve:<version>`, written by
`tools/scripts/package-for-node.sh stella-serve`. The script reads the
version from `STELLA_SERVE_PINNED_VERSION` in
`packages/stella-engine-client/src/version.ts`, the one place it is written.
That package's README has the bump steps. The engine listens on loopback
port 4300 and has no Caddy route and no public hostname. `app` and `api`
reach it as `http://127.0.0.1:4300`.

Before its first deploy an operator creates three parameters:

| Parameter | Value |
| --- | --- |
| `/oxagen/production/stella-serve/STELLA_SERVE_TOKEN` | SecureString, 32 or more random characters |
| `/oxagen/production/STELLA_SERVE_TOKEN` | the same value |
| `/oxagen/production/STELLA_SERVE_URL` | `http://127.0.0.1:4300` |

The token lives twice because the engine's container reads its own prefix
(`config_prefix` in the manifest) and the surfaces read the shared one.
`stella-serve` refuses to start without a token, and the surfaces report
"the assistant engine is unavailable" while theirs is missing or wrong.

## The internal docs site

`internal-docs` serves the internal Oxagen docs (specs, pricing, plans; a
Fumadocs static export built in `macanderson/tmp-oxagen-mockups`) at
`https://internal.oxagen.sh`, behind a password. It must not be publicly
readable, and the password is the only control: the hostname is on the ALB
certificate, so it is published in Certificate Transparency logs.

The artifact is a `caddy:2` container on loopback port **3003** holding the
export under `site/` and its own server config,
`infra/tools/internal-docs/Caddyfile`. The front door proxies the hostname to
it with no auth of its own (`tools/caddy/Caddyfile.alb`). The password check
lives in the site's container because there the bcrypt hash arrives from
Parameter Store through `config_prefix` and is never in git or rendered into a
file on the node.

Parameters, created once by an operator:

| Parameter | Value |
| --- | --- |
| `/oxagen/internal/INTERNAL_DOCS_PASSWORD` | SecureString, the plaintext password, for people. Not under `/oxagen/production`: app, api and mcp load that prefix recursively into their environment. |
| `/oxagen/production/internal-docs/INTERNAL_DOCS_PASSWORD_HASH` | SecureString, the bcrypt hash of the same password (`caddy hash-password`). The site reads it as `config_prefix`. The recursive load also hands it to app, api and mcp; a bcrypt hash is not the password. |

The user name is `oxagen`. Create both without printing either:

```bash
A='env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN aws --region us-east-1'
umask 077; d=$(mktemp -d)
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40 > "$d/pw"
# The password reaches caddy on stdin, not as --plaintext, where any process on
# the machine could read it from the command line. docker needs -i to pass
# stdin through. With stdin not a terminal, caddy hash-password reads one line
# and strips its newline (only the terminal prompt asks twice). The file holds
# no newline, so echo adds one; without it caddy fails with "Error: EOF".
{ cat "$d/pw"; echo; } | docker run --rm -i caddy:2 caddy hash-password | tr -d '\n' > "$d/hash"
for pair in "INTERNAL_DOCS_PASSWORD:/oxagen/internal/INTERNAL_DOCS_PASSWORD:pw" \
            "INTERNAL_DOCS_PASSWORD_HASH:/oxagen/production/internal-docs/INTERNAL_DOCS_PASSWORD_HASH:hash"; do
  IFS=: read -r _ name file <<<"$pair"
  jq -n --arg n "$name" --rawfile v "$d/$file" '{Name:$n,Type:"SecureString",Value:$v,Overwrite:true}' > "$d/in.json"
  $A ssm put-parameter --cli-input-json "file://$d/in.json" >/dev/null
done
rm -rf "$d"
```

Rotating the password is the same commands plus a redeploy, which restarts the
container with the new hash.

Deploy, from a machine with the built export:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  infra/tools/deploy-internal-docs.sh ~/Documents/Oxagen/Mockups/site/out
```

It stages the export, uploads `_deploy/internal-docs-standalone.tgz`, sends
`oxagen-deploy-service service=internal-docs`, and then checks from outside:
401 without credentials, 200 with the password, and `app.oxagen.sh/login` and
`api.oxagen.sh/health` still 200. Release swap and rollback are
`deploy-service.sh`'s. No CI role may publish this artifact yet; until one is
added to `stacks-new/ci-deploy/roles.tf`, it ships by hand.

To take the site down: `docker rm -f oxagen-internal-docs` on the node, delete
`_deploy/internal-docs-standalone.tgz` so a node replacement does not restore
it, remove the `@internal` block from `Caddyfile.alb` and run
`tools/install-node-scripts.sh`, and remove the hostname from `main.tf`.

## Adding a service

1. Have its repository publish `<service>-standalone.tgz` with a manifest.
2. Add its hostname to `/opt/oxagen/caddy/Caddyfile` and reload Caddy.
3. Add the service name to `local.platform_services` (or the relevant role) in
   `stacks-new/ci-deploy/roles.tf` and apply, so CI may publish that object.
