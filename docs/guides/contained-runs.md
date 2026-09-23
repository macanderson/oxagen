# Run an agent in the contained tier on a pull request

You want an agent to work on a pull request in CI, and you need the record to
show it could not reach anything but the gateway. Hooks alone cannot show
that: the agent's own shell can go around them. `tacho run --contained`
starts the agent in a measured Docker container with no network, registers
that measurement with Oxagen before the agent starts, and the run shows tier
`contained` in Fleet.

ADR-152 has the full profile, what it trusts, and what it does not protect
against.

## What you need

- A Linux runner with Docker, where the job runs as an unprivileged user in
  the `docker` group. GitHub's `ubuntu-24.04` runners qualify.
- An Oxagen API token for an org Owner or Admin, and the org and workspace
  slugs. Registering a contained launch requires that role.
- The model vendor's key for the harness: `ANTHROPIC_API_KEY` for Claude Code,
  `OPENAI_API_KEY` for Codex. Enrollment moves it into the gateway's custody,
  and the container never sees it.
- Optional: a GitHub App installed on the repository, if the agent needs to
  fetch or push. You mint a token for this one repository each run.
- The contained image. Build it from `packages/tacho/container/Dockerfile` at
  the tag that matches your `tacho` version, with `--build-arg
  HARNESS=claude-code` or `HARNESS=codex`, and push it where your runners can
  pull it.

## Require the tier for an agent

Add this to the agent's definition and publish it:

```toml
[containment]
required = true
```

In enforce mode, a session of that agent that the launcher did not start is
refused at its first hook: the start, every prompt, and every tool call. A
runner whose `tacho` is too old to read the requirement is suspended until it
upgrades.

## The workflow

```yaml
name: contained review
on: pull_request

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install -g @oxagen/tacho

      # Enrollment takes the key out of this file and into the gateway's
      # custody. The agent gets a fifteen-minute run token per call instead.
      - name: Hand the model key to the gateway
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          mkdir -p ~/.claude
          node -e 'require("fs").writeFileSync(process.env.HOME + "/.claude/settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } }))'

      - name: Enroll this runner
        env:
          OXAGEN_TOKEN: ${{ secrets.OXAGEN_TOKEN }}
        run: >-
          tacho enroll --token "$OXAGEN_TOKEN"
          --org "${{ vars.OXAGEN_ORG }}" --workspace "${{ vars.OXAGEN_WORKSPACE }}"
          --harness claude-code --no-service --validity-days 1

      - name: Start tachod
        run: |
          nohup tacho daemon > "$RUNNER_TEMP/tachod.log" 2>&1 &
          # `status` exits 0 once enrolled; the daemon is up when its gateway listens.
          for _ in $(seq 1 30); do
            tacho status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s||"{}").gateway?.listening?0:1))' && exit 0
            sleep 1
          done
          cat "$RUNNER_TEMP/tachod.log"; exit 1

      - name: Mint the run's GitHub token
        id: github-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.GITHUB_APP_ID }}
          private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
          repositories: ${{ github.event.repository.name }}

      - name: Review, contained
        env:
          OXAGEN_CONTAINED_GITHUB_TOKEN: ${{ steps.github-token.outputs.token }}
        run: >-
          tacho run --contained
          --image ghcr.io/your-org/oxagen-contained-claude-code:2.1.1
          --github-repository "${{ github.repository }}"
          -- claude -p "Read the diff against origin/main and list the three riskiest changes, with file and line."
          --max-turns 20

      - name: Unenroll this runner
        if: always()
        run: tacho unenroll
```

Drop the token step and `--github-repository` if the agent only reads the
checkout. For Codex, build the image with `HARNESS=codex`, put the key in
`~/.codex/auth.json` as `OPENAI_API_KEY`, enroll with `--harness codex`, and
run `-- codex exec "<task>"`.

The checkout must not contain `node_modules` or anything else installed with
hard links, and no `.env`, `.env.local`, `.npmrc`, `.netrc` or similar file.
Committed templates such as `.env.example` are fine. Install your tools in
the image, not in the checkout.

This repository runs the same job on its own pull requests in
`.github/workflows/contained.yml`.

## What happens

1. `tacho run` asks the local `tachod` for one run and streams the agent's
   output back. It exits with the agent's exit code.
2. The launcher creates the container: no network, a read-only root, all
   capabilities dropped, your checkout read-write at `/workspace`, and the
   hook configuration read-only.
3. It inspects the container, sends the measurement and the session's chain
   genesis to Oxagen, and starts the agent only after Oxagen accepts it.
4. Inside, the agent reaches the model, the hooks, Oxagen's MCP tools, and,
   with a token, your one repository. Each goes through a socket to the
   daemon, which adds the credential outside the container. Every other
   request is refused and recorded.
5. When the run ends, the launcher removes the container and revokes the
   GitHub token.

Oxagen marks the run `contained` when the chain verifies, the model or MCP
traffic went through the gateway, and the receipt's genesis matches the
chain. The launcher never sets the tier itself.

## When the launcher refuses

`tacho run` prints the reason and exits 1 before the agent starts:

| Message | What to change |
|---|---|
| `Contained execution requires an unprivileged Linux runner with Docker` | Run the job as a non-root user on Linux |
| `Docker cannot provide the Linux containment profile` | Use a Docker daemon running Linux containers |
| `The operator's contained image is not installed` | Pull or build the image on the runner first |
| `Remove local credential files from the contained checkout before launch` | Delete `.env`, `.npmrc` and similar files from the checkout |
| `Contained repository contains a hard-linked file` | Check out a clean tree with no installed dependencies |
| `Contained launch registration failed (409)` | The workspace's database is missing the contained-launch migration, or this session already has a different receipt |
| `The run's GitHub token must reach <repo> and no other repository` | Mint the token with `repositories:` set to this one repository |
| `The daemon must hold this harness's model credential before containment can start` | Put the vendor key in the harness settings before `tacho enroll` |

## What contained does not cover

The container holds against the agent and anything it starts. It does not
hold against whoever administers the runner: membership in the `docker` group
is root there. ADR-152 lists what that person can still do. On a hosted CI
runner that is GitHub, and on your own runner it is you.
