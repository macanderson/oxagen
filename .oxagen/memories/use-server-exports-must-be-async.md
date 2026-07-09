---
name: use-server-exports-must-be-async
type: observation
domain: app
severity: P2
linear: none
date: 2026-07-04
---

**Observation:** Next.js `"use server"` modules (e.g. every `apps/app/src/app/**/actions.ts`) may only export **async** functions — a synchronous export is a build error. This creates a footgun: authors add a small pure helper (parsing, mapping) to an `actions.ts`, are forced to make it `async`, and then a synchronous caller (a `zod.safeParse` object literal, a `.map`, a spread) silently receives a `Promise` instead of the value.

**Fragile pattern to grep for:** any `parse*/build*/normalize*` helper defined in a `"use server"` file and called WITHOUT `await` — especially inside a synchronous `safeParse({ field: helper(...) })`. zod reports it as `received: "promise"` and the whole action fails with a generic error string, which surfaces to users as a vague validation message and to e2e as a downstream timeout (the real cause is upstream).

**Rule:** put pure, synchronous helpers in a sibling **non-`"use server"`** module and import them into the action. Keep only genuine server actions (async, network/DB-touching) in `actions.ts`. Unit tests that call a helper synchronously (`expect(helper(x)).toEqual(...)`) are a signal the helper was meant to be sync — honor that.

**Also:** e2e chat specs that MOCK `**/api/v1/chat/stream` still exercise the REAL `sendMessageAction` server action first (persist user turn → then fetch stream). If the send action fails, the mock never fires. When a chat e2e "the streamed card never appears," check the send action / composer error state BEFORE suspecting the stream reducer or the card component.
