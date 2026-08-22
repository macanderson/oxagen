# Node-side deploy scripts

These run on the shared application node (`i-023d002d6e44f8f84`), not on a
developer's machine and not on a CI runner. `tools/install-node-scripts.sh`
copies this directory to `/opt/oxagen/bin`.

They exist so that CI does not have to. A GitHub Actions role that could send
`AWS-RunShellScript` to this instance would have root on the box that runs
Postgres, Neo4j and ClickHouse; instead each CI role may send exactly one SSM
document, `oxagen-deploy-service`, whose only argument is a service name
constrained by `allowedPattern`. The privilege lives here, in version control,
where it can be read and reviewed.

## The contract: `oxagen-run.json`

A deployable artifact is a gzipped tarball named `<service>-standalone.tgz`,
uploaded to `s3://oxagen-deploy-578673726240/_deploy/`, whose root holds a
manifest describing how it runs:

```json
{
  "port": 3001,
  "image": "node:22-alpine",
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
| `image` | yes | Container image. **Must have an `arm64` variant** — the node is a `t4g.medium`. |
| `command` | yes | Argv, relative to the tarball root, which is mounted at `/app`. |
| `memory` | no (`512m`) | Hard container limit. |
| `health_path` | no (`/`) | Path polled for up to 60s after start. |
| `env` | no | Non-secret environment. This file ships inside a public CI artifact. |
| `config_prefix` | no | Parameter Store prefix; every parameter under it becomes an environment variable named after its last path segment. |

The manifest is what makes the deploy path generic. Passing the image, port and
command as SSM parameters instead would mean an infrastructure change and a
Terraform apply every time an application changed how it starts, and it would
widen the document's arguments from one validated identifier to a set of
strings that reach a command line.

### Why `config_prefix` rather than baking configuration in

Secrets in the artifact would mean rebuilding the application to rotate one,
and would put them in a tarball produced by a public CI job. Read at start
instead, a rotation is a parameter write plus a restart. The values are written
to a root-owned `0600` file and passed with `--env-file`, never with `-e`:
`-e` would put every secret into the instance's process table, where
`docker inspect` and `ps` show them to anything running on the box.

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
aws ssm start-session --target i-023d002d6e44f8f84
ls /opt/oxagen/services/<service>/releases
```

## Adding a service

1. Have its repository publish `<service>-standalone.tgz` with a manifest.
2. Add its hostname to `/opt/oxagen/caddy/Caddyfile` and reload Caddy.
3. Add the service name to `local.platform_services` (or the relevant role) in
   `stacks/ci-deploy/roles.tf` and apply, so CI may publish that object.
