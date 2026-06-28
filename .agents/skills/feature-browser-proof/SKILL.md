---
name: feature-browser-proof
description: Prove a feature is actually built by driving a real browser in a durable sandbox and having an INDEPENDENT LLM judge the screenshots. Use whenever a code agent finishes (or claims to finish) building or changing a user-facing feature and needs to demonstrate it works — "prove it works", "is it built?", "show me the feature", before declaring a UI/flow done, or as the definition-of-done gate for any feature with a visible surface. Drives durable sandbox sessions (agent.sandbox.*) + browser automation (browser.*) + the cross-LLM judge (agent.feature.verify). Do NOT self-certify a visible feature without this.
---

# Feature browser proof — definition of done for visible features

A feature with a visible surface is **not done** until a browser has shown it
working **and a different LLM than the one that built it has read the
screenshots and agreed.** You cannot self-certify: the model that wrote the code
is exactly the model most likely to hallucinate that it works. This skill runs
the loop end-to-end inside a **durable sandbox** that survives across turns.

## The capabilities you use

| Step | Capability | Notes |
|---|---|---|
| Provision a long-lived sandbox | `agent.sandbox.start` | Pass a stable `sessionKey` (the conversation/agent-run id) so the SAME warm sandbox is reused across turns. Use `image: "agent"`. |
| Run commands in it (clone, install, build, start dev server) | `agent.sandbox.exec` | Filesystem + processes persist across calls. Start the dev server in the background. |
| Checkpoint at milestones | `agent.sandbox.snapshot` | So an idle reap or the 24h ceiling restores transparently. |
| Drive the browser | `browser.navigate` / `browser.fill` / `browser.submit` / `browser.click` / `browser.refresh` / `browser.read` | One live page, shared state across calls; it reaches the app on the sandbox's own `localhost`. |
| Capture the success state | `browser.screenshot` | Stored as a PRIVATE asset; returns a `key`. |
| **Independent verdict** | `agent.feature.verify` | A DIFFERENT-vendor vision model reads the screenshots vs. the requirement. |
| Tear down | `agent.sandbox.stop` | When the work is accepted. |

## The loop (do this exactly)

1. **Start the durable sandbox.** `agent.sandbox.start({ image: "agent", sessionKey: <conversation/run id> })` → keep the returned `sessionId`. Reuse the same `sessionKey` every turn so you reconnect to the same warm box.

2. **Build the feature in the sandbox.** Via `agent.sandbox.exec`: clone the repo (use the provided token), install deps, apply your change, build, and start the dev server in the background (e.g. `nohup … &`). Snapshot after the expensive setup.

3. **Drive the browser to the feature.** `browser.navigate({ sessionId, url: "http://localhost:<port>/<the feature route>" })`. Exercise the actual flow with `browser.fill` / `browser.submit` / `browser.click`; use `browser.read` to assert key copy/state appeared; `browser.refresh` after a rebuild.

4. **Screenshot the success state(s).** `browser.screenshot({ sessionId, fullPage: true })` (and element shots via `selector`) at each state that proves the requirement. Keep the returned `key`s.

5. **Get an INDEPENDENT verdict.** Call `agent.feature.verify`:
   - `requirement`: the exact thing the feature must do/show (the user's ask).
   - `screenshotKeys`: the keys from step 4.
   - `builderModel`: **your own model id** — this forces the judge onto a different vendor. Always pass it.
   - `checklist`: the concrete elements that must be visible/working.

6. **Honor the verdict — it is the gate.**
   - `verdict: "pass"` → the feature is proven. Cite the judge model and observations.
   - `verdict: "fail" | "inconclusive"` → it is **NOT done.** Read `issues`, fix the code in the sandbox, re-screenshot, and re-verify. Loop until `pass` (or escalate after a few honest attempts with the judge's reasoning).

7. **Stop** the sandbox with `agent.sandbox.stop({ sessionId })` once accepted.

## Rules

- **Never declare a visible feature done on a `fail`/`inconclusive` verdict, or without running the judge at all.** A passing unit test is not a substitute — the judge reads the rendered pixels.
- **Always pass `builderModel`** so the judge is genuinely a different LLM. If you skip it the judge defaults to excluding the platform's default vendor, but passing it is required for a guaranteed split.
- **Screenshot the real success state**, not a loading spinner or an empty page — the judge is told to FAIL those.
- **One durable sandbox per task** (via `sessionKey`); don't spin up a fresh sandbox every turn.
- For features with **no visible surface** (a pure API/CLI/db change), prove it with `agent.sandbox.exec` output (curl the endpoint, run the CLI, query the db) and have a teammate/judge review that evidence instead — the browser loop is for visible surfaces.

## Why a different model judges

The builder model has a strong prior that its own work succeeded. An independent
vision model from a **different vendor**, given only the requirement and the
pixels, has no such prior — it catches the blank page, the 500, the missing
button, the wrong copy. That adversarial gap is the entire point: it's the
difference between "I think it works" and "a skeptical outsider confirmed it
works." `agent.feature.verify` enforces the vendor split for you.
