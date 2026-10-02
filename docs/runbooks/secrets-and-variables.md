# Secrets and variables

You need a working `.env.local`, or you need to change a key that leaked or
expired. Every value lives in SSM Parameter Store, in account 916294258235,
region us-east-1 (ADR-240). Two scripts move values between the store and your
machine: `pnpm env:pull` reads and `pnpm env:push` writes.

What each variable is, where it lives, and how to mint a new one is in two
places that agree by test:

- `packages/config/src/registry.ts`, the `store` and `refresh` fields of each
  entry, for everything a service or a maintainer reads.
- `packages/config/src/ci-registry.ts` for every GitHub secret and variable a
  workflow reads.

The Architecture Atlas renders both in its Secrets and variables section.

## Prefixes

| Prefix | Holds |
|---|---|
| `/oxagen/production` | Production values |
| `/oxagen/staging` | Staging values (the registry's `preview`) |
| `/oxagen/development` | Values every laptop shares |
| `/oxagen/operator` | Maintainer tooling secrets no service reads |

A static value, such as a public URL, lives in the registry and in no
parameter.

## Set up a laptop

1. Install the AWS CLI v2.

   ```bash
   brew install awscli
   ```

2. Sign in to account 916294258235, then confirm who you are.

   ```bash
   aws configure sso        # or aws configure, for an IAM user's access key
   aws sts get-caller-identity
   ```

   Set `AWS_PROFILE` in your shell, or pass `--profile <name>` to the scripts
   below, if the account is not your default profile.

3. Write the four `.env.local` files: the root, `apps/app`, `apps/api`, and
   `apps/mcp`.

   ```bash
   pnpm env:pull
   ```

4. Start the stack.

   ```bash
   pnpm dev
   ```

   `pnpm dev` runs `pnpm env:pull` by itself when a file is missing.

`pnpm env:pull` never reads production. `--env staging` reads the staging
values, for debugging the staging stack.

## Pull again

Run `pnpm env:pull` after someone changes a value. To see what would change
without writing anything:

```bash
pnpm env:pull --check
```

It prints key names, never values, and exits 1 when a file would change.

### Local overrides

Each file ends with this line:

```
# --- local overrides: env:pull keeps everything below this line ---
```

The pull rewrites everything above the line and keeps everything below it. A
key below the line wins over the pulled value. Put machine-specific values
there, such as a different `DATABASE_URL`.

The first pull over a file written by the old Vercel pull keeps the old file
as `.env.local.bak`. It also moves every key the store does not hold below the
line, so nothing you set by hand is lost. Read that block once and delete what
you do not need.

### Operator values

```bash
pnpm env:pull --operator
```

This adds `/oxagen/operator` to the root `.env.local` only. Pull it when you
publish the CLI, sign the desktop app, or run another maintainer script.

## Save a value

```bash
pnpm env:push STRIPE_SECRET_KEY --env development
```

The script prompts for the value without echoing it. It never takes the value
as an argument, because an argument shows up in your shell history and in the
process list. To save a file as it is, such as a PEM key:

```bash
pnpm env:push GITHUB_APP_PRIVATE_KEY --env production < oxagen-connect.private-key.pem
```

`--env` takes `development`, `staging`, `production`, or `operator`. The
script refuses a key the registry does not list, and a key whose `store` puts
it somewhere else. It saves a SecureString when the registry marks the key
`secret`.

## Rotate a secret

1. Find the variable in the Atlas inventory, or in its registry entry, and read
   its refresh step. Some rotations sign people out or make connectors
   reconnect. The step says so.
2. Mint the new value where the step says, with its command when it has one.
3. Save it in each environment that holds it.

   ```bash
   pnpm env:push <KEY> --env production
   pnpm env:push <KEY> --env staging
   pnpm env:push <KEY> --env development
   ```

4. Restart the services that read it. The registry entry's `services` lists
   them. A `NEXT_PUBLIC_` value is compiled into the app bundle, so it needs a
   new deploy of `app` instead.
5. Confirm the feature that uses the key works.
6. Revoke the old value at the vendor.

### Restart a service

The node reads Parameter Store when a container starts. Sending the deploy
document again starts the service's current artifact with the new values:

```bash
aws ssm send-command --document-name oxagen-deploy-service \
  --targets Key=tag:Name,Values=oxagen-app \
  --parameters service=api
```

Repeat for `app` and `mcp` as the variable needs. For staging, target
`Key=tag:Name,Values=oxagen-staging-app`.

## Change a CI secret

CI reads GitHub Actions secrets and variables until phase 3 of ADR-240 moves
them to `/oxagen/ci`. Run these from a checkout, and `gh` picks the repository
from the git remote:

```bash
gh secret set NPM_TOKEN                          # prompts for the value
gh secret set STRIPE_SECRET_KEY --env production # an environment secret
gh variable set STAGING_ENABLED --body true
```

## Add a variable

1. Add an entry to `ENV_REGISTRY` in `packages/config/src/registry.ts`. Give it
   a `refresh` step if a service reads it or a maintainer keeps it. A test
   fails without one.
2. Regenerate `.env.example`.

   ```bash
   pnpm env:check --write
   ```

3. Save its value in each environment that needs it with `pnpm env:push`.

A new GitHub secret or variable goes in `CI_REGISTRY` instead.
`pnpm env:check` fails when a workflow reads one that file does not list.

## Seed a prefix

To fill `/oxagen/development` or `/oxagen/operator` from a `.env.local` that
works:

```bash
pnpm env:push --from .env.local --env development          # prints the plan
pnpm env:push --from .env.local --env development --apply  # writes it
```

The plan lists each key as new, changed, or unchanged, and names the keys it
skips with the reason. Production is refused. Change production one key at a
time.

## Troubleshooting

- **`AccessDeniedException` or `ExpiredToken`.** Your AWS session ended or
  lacks access to the prefix. Run `aws sts get-caller-identity`, then sign in
  again.
- **"required in development and missing".** No parameter holds the key and
  the registry has no static value for it. Save it with
  `pnpm env:push <KEY> --env development`.
- **"the store and the registry disagree".** A parameter repeats a registry
  static value with a different value. The registry's value wins. Delete the
  parameter, or change the registry if the parameter is right (#4833).
- **A key you set by hand disappeared.** It was above the override line. Find
  it in `.env.local.bak` or set it again below the line.
