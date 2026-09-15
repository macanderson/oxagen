# Examples

Finished prose per surface. Copy the structure, not the sentences, unless the sentence is one of the approved lines in `positioning.md`.

## Website hero

**Headline.** The agent doesn't get to decide it's done.

**Sub.** Oxagen locks a definition of done into every run before the agent's first tool call and blocks the run from ending until it holds. When it does, the result is settled into a signed record anyone can verify offline.

**Action.** Wrap Claude Code in sixty seconds

**Under the action.** Two hooks. No account for your agents. The first screen shows your own numbers.

## Product page, the dod section

### Define done before the agent starts

A dod is a short file with four kinds of check: a command that must exit clean, a file that must contain a line, a diff that must stay inside a set of paths, and a judgment a named person signs after the run. You write one by hand for a task that repeats, or Oxagen drafts one from your prompt. Either way it is locked before the first tool call, and the agent can read it and cannot change it.

### The run cannot end until it holds

When the agent tries to stop, the wrapper runs every check on the agent's own machine and records the results as a frame in the run. Broken, and the agent gets the failing ids and keeps working. Held, and Oxagen settles the result. Broken three times, and the run ends broken, on the record, with the reasons.

### Prove it to someone who doesn't trust you

The verdict is a pure function of the run's frames. There is no model in it. Export the run and hand it to your auditor; `oxagen dod verify` recomputes the verdict with no account and no network and tells them whether it matches.

## Product page, the access section

### Don't hand your agents the keys

An agent under Oxagen holds an identity and a mandate. It does not hold a token to GitHub, a password to the database, or a standing grant to anything. When a task needs one of those, the agent asks. The request carries who started the task, which agent is asking, which tool it wants, and which data it would reach.

### A rule you wrote answers

The team that owns the system writes the rule. Reads of the public repo: allowed. A push to main: denied. A push to a release branch: routed to the release owner, who sees the request with the diff beside it and answers from the Access page. Allowed and denied requests settle inside the same call. Routed requests wait for the person, and the run waits with them.

### The key never moves

The credential stays in Oxagen, encrypted under a key you own. Oxagen makes the connection on the agent's behalf and closes it when the action is done. The agent never sees the key. The record shows every use: the request, the rule that answered it, and the person who signed it.

## Docs, writing a rule

Write one rule for each thing an agent may ask for. A rule names a capability, a condition, and one of three effects: allow, deny, or require approval. Requests that match allow or deny settle inside the call and leave a row with the rule id. Requests that match require approval wait for the person the rule names, and the run waits with them. Rules are checked after identity, so a rule can narrow what an agent may do and never widen it.

## Docs introduction

Oxagen adds two hooks to Claude Code. The first runs when you submit a prompt: it loads a definition of done for the task, or drafts one, and locks it into the run. The second runs when the agent tries to stop: it runs the checks and blocks the stop if any fail. Everything else happens in Oxagen and you can read it on the run page.

To install, open the Agents page and choose Wrap Claude Code. The installer writes the hooks and enrolls this machine. The page turns to connected when the first frame arrives.

## Launch post, first three paragraphs

Today a coding agent tells you it is finished, and you read the PR to find out whether it was right. That order is backwards, and it is the reason agent output still needs a person to read every line.

Oxagen reverses it. Before an agent makes its first tool call, the run has a definition of done: a locked file with the commands that must pass, the files that must change, the paths that must not, and the judgment a person will sign. The agent can read it. It cannot change it. And the run cannot end until the checks hold.

We built the dod on Mission Control's run record, so every check result is a frame in the same chain as every tool call and every model call, and the seal signs all of it. Export the run and anyone can recompute the verdict with fifteen lines of code and no account. We think that last part matters more than any of the rest, because it is the first thing in this category an outside party can depend on.

## Sales email

Subject: The agent doesn't get to decide it's done

Hi Dan,

Your team runs Claude Code against the Cary permitting codebase, and someone reads every PR to find out whether the agent finished the task or stopped when it felt finished. That reading is the expensive part.

Oxagen locks a definition of done into each run before the agent starts and blocks the run from ending until it holds. I can show you one run, one blocked stop, and one held dod in twenty minutes, on your codebase. If it is not obvious in the first ten, I will stop.

Mac

## Sales email, security lead

Subject: Don't hand your agents the keys

Hi Sam,

Your coding agents run with a GitHub token that can push to every repo, because that was the only way to get them working. Nobody chose that. It is how tokens work.

Oxagen gives the agent an identity instead of a token. When a run needs GitHub, the agent asks, a rule you wrote answers, and the request is a row in the record with the rule that answered it. I can show you one denied push and one routed to a person in twenty minutes, on your repos.

Mac

## Investor paragraph

One engineer, eight months, a live platform, three paying design partners, and a customer council of nine. The product wraps Claude Code in sixty seconds and records every run frame by frame with its cost. On top of the record it does one thing nobody else does: it locks a definition of done before the agent starts, blocks the run until it holds, and lets an outside party recompute the result offline. The meter follows the proof: customers pay for proven runs, and runs and governed actions are reported as secondary meters. The next twelve weeks ship the dod on the existing recorder and put one before-and-after number from one design partner in front of the council.

## UI strings

| Place | String |
|---|---|
| Run page, dod panel header | Definition of done |
| Lock line | Locked before tool call 1, `sha256:4c1f…9e02` |
| Verdict, held | held |
| Verdict, pending | pending, waiting on reviewer |
| Verdict, broken | broken: unit, scope |
| Stop blocked toast in Claude Code | Stop blocked. Broken: unit, scope. |
| Enforcement, observe tier | recorded, not enforced |
| Empty state, no dod | This run has no definition of done. Add one under `.oxagen/dod/` or let Oxagen draft it at the next prompt. |
| Verify success | Verdict matches. held, 0 reasons, seal ok. |
| Verify failure | Verdict does not match. Expected held, found broken. See the diff below. |
| Access page, request row, allowed | allowed by rule `repo-read` |
| Access page, request row, denied | denied by rule `no-push-main` |
| Access page, request row, routed | waiting on Priya, rule `release-branch` |
| Request card header | Access request |
| Request card body | Push to `release/2026.09` requested by stella for Dana's task. Reaches 14 files in `apps/api`. |
| Request card actions | Allow for this run · Deny |
| Empty state, no rules | This workspace has no rules. Requests are answered by identity alone. Write the first rule under Access. |
| Connection row | GitHub, held by the workspace. The agent never sees the key. |

## Error messages

Say what happened, then what to do. Never apologize. Never say "oops."

- Request denied by rule `no-push-main`. Push to a branch and open a pull request.
- Request is waiting on Priya, rule `release-branch`. The run resumes when she answers.

- The dod on disk does not match the lock. Restore `$OXAGEN_RUN_DIR/dod.toml` or start a new run.
- Check `unit` timed out after 600 seconds. Raise `timeout_s` in the dod or split the command.
- No dod matched task `github:macanderson/oxagen#2701`. Oxagen drafted one; review it at `$OXAGEN_RUN_DIR/dod.toml`.
- This run reached observe tier. The dod was recorded, not enforced. Wrap the harness to enforce it.

## Ad copy

Three approved ads live in `ads/`. Their copy:

**Ad 1, social 1200 by 628.**
Headline: The agent doesn't get to decide it's done.
Body: Oxagen locks a definition of done before the first tool call and blocks the run until it holds.
Action: Wrap Claude Code in 60 seconds

**Ad 2, square 1080 by 1080.**
A rendered stop-blocked card: Stop blocked. Broken: unit, scope.
Line under it: Runs that end with a verdict, not a claim.
Action: See a run

**Ad 3, social 1200 by 628.**
A terminal: `$ oxagen dod verify run_01J9AB3K.json` then `verdict matches. held. seal ok.`
Headline: Prove it to someone who doesn't trust you.
Action: Read the source

## Commit messages and PR descriptions

Same voice, present tense, what changed and why in one line each.

- `dod: lock before the first tool frame, LOCKED_LATE otherwise`
- `dod-harness: one dod.checked frame per stop instead of one per check`
- PR description: "Adds the settle handler. It reads the chain, runs decide(), and appends dod.settled. Human checks resolve through the existing approvals; there is no dod.sign."
