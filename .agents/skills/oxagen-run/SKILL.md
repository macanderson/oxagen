---
name: oxagen-run
description: Launch, health-check, AND prove the Oxagen local dev stack (Next app :3000, docs :3300, API :4000, MCP :4100, plus the Postgres/ClickHouse/Neo4j Docker datastores) — and the standing wrap-up step for finishing ANY piece of work. Use this whenever the user or the built-in /run command wants to start, run, boot, restart, relaunch, or "spin up" the project locally, serve the app, see it in a browser, or check whether it's running, even from a bare "run it", "get it up", or "is it up?". ALSO use it at the END of every task to PROVE completion: it brings the stack up, logs into the app with the local creds.json, drives to the surface that changed, captures screenshots of the success state (or the equivalent runtime evidence for changes with no visible surface), and presents that proof to the developer. Treat "are we done?", "wrap this up", "show me it works", "prove it", and "before you call it finished" as triggers too. It knows `pnpm dev` is a long-running blocking process that must be backgrounded, that the first compile is slow, and that `pnpm kill` tears down the Docker datastores and app servers a PARALLEL session may be using — so it reuses a healthy stack instead of blindly killing, only running `pnpm kill && pnpm dev` when the stack is wedged or a port conflicts. Do NOT use this for production deploys (that is Vercel) or for running the test suite (that is `pnpm gate` / test-completeness-judge).
---

# Run, verify, and prove the Oxagen local dev stack

This skill does two jobs: **bring the local stack up safely** (Part 1), and **prove a piece of
work actually works in the running app** (Part 2). The built-in `/run` command defers to this
skill for launching, and you should reach for it yourself at the end of every task.

## When to use it

- **Launching / health:** any "start it", "run it", "spin it up", "restart the stack",
  "is the app up?" request, or whenever `/run` fires.
- **Wrapping up — always.** When you finish *any* unit of work, use this skill to produce visible
  proof for the developer before you claim completion. This is the house rule: *no task is done
  until proven with evidence.* Green tests and green CI (covered by `ci-green` and
  `test-completeness-judge`) prove the code *type-checks and passes* — they do **not** prove the
  running app does the thing a human can see. That gap is what this skill closes.

The one mistake that costs the most time is **blindly killing a stack another session is using.**
This developer works in parallel — multiple terminals and agent sessions against the *same* repo —
so understanding exactly what `pnpm kill` and `pnpm dev` do is what lets you avoid clobbering them.

## What the two commands actually do (read before acting)

**`pnpm dev`** (`tools/scripts/dev.ts`) — the launcher. In order, it:
1. Strips over-quoted env values and sets `OXAGEN_LOCAL_DEV=1` (relaxes deployed-only auth so local sign-in works).
2. Bootstraps `.env.local` from Vercel if missing, then **pins `.env.local` over the shell env** (so a stale exported `DATABASE_URL` can't retarget the stack — it warns if it had to repin).
3. **Requires the Docker daemon.** If Docker isn't running it prints `Docker is not running. Start Docker Desktop and retry.` and exits 1. You cannot start Docker Desktop — surface this to the user.
4. `docker compose up -d`, then waits up to 60s for containers healthy. **This is idempotent** — running it when the datastores are already up is harmless and fast.
5. Runs `pnpm db:migrate`.
6. Starts the **Stripe webhook tunnel** and the **Inngest dev server** — both *before* turbo, so the API inherits the Stripe signing secret and `INNGEST_DEV=1`.
7. `pnpm turbo dev` for all apps — a **persistent, blocking, never-exits** process.

Two consequences that drive everything below:
- Step 7 never returns, so **launch `pnpm dev` in the background** and then poll for readiness. Foreground will hang your turn.
- Docker bring-up (step 4) is idempotent, but turbo (step 7) hits `EADDRINUSE` if an app port is already bound — so the **only** thing that blocks a clean `pnpm dev` is the four app ports already being in use.

**`pnpm kill`** (`tools/scripts/kill.ts`) — the teardown. It:
- `pkill`s only the `tsx`/`node` processes whose command line contains **this repo's absolute path** (repo-scoped — it will NOT touch a different project's dev servers).
- Stops the Stripe tunnel and Inngest dev server via their pidfiles.
- Runs `docker compose ... down --remove-orphans` — **this stops the Postgres / ClickHouse / Neo4j containers, which are shared across every session of this repo.** Data volumes survive unless `--volumes` is passed.

So `pnpm kill` is safe against *other repos* but **destructive to a parallel session of THIS repo**: it kills their app servers and drops the shared datastores out from under them.

## Ports

| Port | Service | Lifecycle |
|------|---------|-----------|
| 3000 | `apps/app` (Next) | turbo / node — slow first compile |
| 3300 | `apps/docs` (Fumadocs) | turbo / node |
| 4000 | `apps/api` (Hono) | tsx |
| 4100 | `apps/mcp` (xmcp) | tsx |
| 5433 | Postgres | Docker |
| 8123 | ClickHouse | Docker |
| 7687 | Neo4j | Docker |

The **app ports (3000/3300/4000/4100)** and the **Docker datastore ports (5433/8123/7687)** have
independent lifecycles. It is normal — and the most common partial state — for Docker to be up
while the app servers are down. Treat them separately.

---

## Part 1 — Bring the stack up safely

### 1. Health-check first — never assume

A port can be *bound* while Next is still *compiling*, so probe the port AND confirm the app
responds. Run this read-only check before doing anything:

```bash
for p in 3000 3300 4000 4100 5433 8123 7687; do
  pid=$(lsof -ti:$p 2>/dev/null)
  [ -n "$pid" ] && echo "port $p: UP (pid $pid)" || echo "port $p: free"
done
curl -sf -o /dev/null -w "app :3000 -> HTTP %{http_code}\n" --max-time 5 http://localhost:3000 || echo "app :3000 not yet responding"
```

### 2. Branch on what you found

- **All four app ports respond:** the stack is already up. **Reuse it** — do not kill or relaunch
  (another session may own it, and a cold reboot wastes a minute). Go straight to Part 2.
- **App ports free (Docker up or down):** run `pnpm dev` directly. No kill — nothing is bound on
  the app ports, and `pnpm dev` brings Docker up idempotently. The common case.
- **Mixed / wedged** — some app ports bound but not responding, a stale process, or you *attempt*
  `pnpm dev` and hit `EADDRINUSE`: this is the one time to `pnpm kill` first, then `pnpm dev`.
  **Before you kill, consider whether a parallel session owns those servers** — if the user
  mentioned parallel work and the stack looks healthy, prefer asking over killing.

### 3. Launch in the background

`pnpm dev` blocks forever, so start it detached with the Bash tool's **`run_in_background: true`**,
then poll. Only prepend `pnpm kill;` in the wedged/`EADDRINUSE` case:

```bash
pnpm dev            # or:  pnpm kill; pnpm dev   (wedged/EADDRINUSE only)
```

### 4. Wait for real readiness (the first compile is slow)

Next's first compile commonly takes **60s+**, and servers bind their ports *before* they can
serve. Poll the HTTP endpoint (not just the port) with a ~90–120s budget, and pre-warm the route
you care about by requesting it:

```bash
for i in $(seq 1 60); do
  code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000 2>/dev/null) && \
    { echo "app ready: HTTP $code"; break; }
  sleep 3
done
```

Watch the backgrounded `pnpm dev` log while you wait — `[dev] all containers healthy`,
`[dev] running pnpm db:migrate`, then turbo's per-app `ready` lines are your progress markers.

### Failure modes

- **`Docker is not running. Start Docker Desktop and retry.`** — you can't launch Docker Desktop;
  tell the user to start it (they can run `! open -a Docker` and wait for the whale icon), then retry.
- **`EADDRINUSE` / port already in use** — an app server is already bound. The canonical kill case:
  `pnpm kill; pnpm dev` (after deciding it isn't a parallel session you'd clobber).
- **`[dev] shell env differed from .env.local and was repinned …`** — informational; the launcher
  already corrected it. No action.
- **A `/_global-error` or `/_not-found` `useContext (null)` prerender crash in the log** — a
  **local-only** macOS/Node-24 artifact; CI builds all four apps green. It does NOT stop the dev
  servers from serving. Do not chase it as a blocker.
- **Restarting only `apps/api` "to save time"** — don't. The Stripe signing secret and `INNGEST_DEV`
  are exported by `dev.ts` *before* turbo; a partial restart loses them and webhook verification /
  local event consumption break. Always restart the **full** stack via `pnpm dev`.

---

## Part 2 — Prove the work (the wrap-up flow)

The point of wrapping up here is to hand the developer **evidence**, not assurances. Match the
evidence to what actually changed.

### When the change has a visible surface (UI, a page, a flow)

1. **Ensure the stack is up** via Part 1.
2. **Log in.** Local auth is email + password only (no email verification). Credentials live in
   `creds.json` at the repo root — it is gitignored; **read it, never print or commit the password.**
   - Returning user → `/login`. Brand-new DB → `/signup` → `/new-organization` → create org →
     you land at `/{orgSlug}/{workspaceSlug}/ask`.
3. **Drive to the surface you changed** and exercise it for real — submit the form, fire the action,
   trigger the toast, open the drawer. Don't screenshot an idle page; screenshot the **success
   state** (the saved value, the success toast, the new row).
4. **Capture screenshots** to the gitignored proof dir and name them for what they prove:
   `apps/app/e2e/screenshots/run-proof/<short-name>.png` (covered by the `**/e2e/screenshots/`
   gitignore — never committed).
5. **Present the screenshots to the developer** as files/inline images, each captioned with the
   one thing it proves (e.g. "workspace name persisted after reload", "invite email row created").
   This is the deliverable — surfacing the files is the whole point, so don't just save them.

### When the change has no visible surface (migration, contract, API route, CLI)

A screenshot of an unchanged page proves nothing. Capture the **equivalent runtime evidence**
against the running stack instead, and present it:
- **API route:** `curl` the live endpoint on `:4000` and show the JSON response (status + body).
- **MCP tool:** exercise it on `:4100` and show the result.
- **Migration / DB change:** run the `SELECT` that confirms the change landed (echo the target DB
  URL first — local is `localhost:5433`).
- **Background job / event:** show the Inngest dev log line proving the event was consumed.

### Browser tooling & gotchas

Use whichever browser MCP is connected:
- **chrome-devtools MCP** (house preference). Its `fill` tool **appends** to inputs — to set a
  React-controlled field, use `evaluate_script` with the native value setter plus a bubbling
  `input` event, or you'll get concatenated garbage.
- **Playwright MCP** (`mcp__playwright__browser_*`) as a fallback — `browser_type` / `browser_fill_form`
  behave normally there.

Take the screenshot with the same MCP you're driving with, save to the proof dir above, and present.

### What "done" looks like

You've wrapped up correctly when the developer can *see* the change working: the stack is serving,
you reached the changed surface logged in, and you've handed over captioned screenshots (or the
runtime evidence) of the success state. State plainly what each artifact proves — no hedging.
