---
name: mobile-composer-hidden-missing-min-h-0
type: bug
domain: web-app
severity: P2
linear: pending (LINEAR_API_KEY in .env.local returns 401 — needs rotation; ticket to be filed by Mac)
date: 2026-06-23
---

**Symptom:** On mobile portrait the Ask/chat composer's Send button was pushed
far below the fold and sat behind the fixed `MobileBottomBar` — users could not
see or tap Send. On desktop the composer was fine. (#126 had already scoped the
shell `<main>` bottom-bar clearance to `max-md:` to fix a *separate* desktop
excess-padding bug; this mobile occlusion was a distinct, deeper layout fault.)

**Root cause:** The chat content column in
`apps/app/src/app/[orgSlug]/[workspaceSlug]/_shared/conversation-page.tsx`
(`<div className="min-w-0 flex-1">` wrapping the `h-full` ChatShell) is a
`flex-col` flex item on mobile (`flex h-full flex-col gap-3 md:flex-row`). It
had **no `min-h-0`**, so by the flexbox default `min-height: auto` it could not
shrink below its intrinsic content height. The inner
`min-h-0 flex-1 overflow-y-auto` message scroller in `chat-shell-client.tsx`
therefore never engaged — the whole conversation grew taller than the viewport,
`h-full` resolved to that ballooned height (measured 1198px), and the
bottom-pinned composer landed at y≈1339 in an 844px viewport, below the bottom
bar at y=787. On desktop the column is `md:flex-row`, where `align-items:
stretch` auto-bounds item height, so the bug only appeared on mobile.

**Fix:** Add `min-h-0` to that content column (`min-h-0 min-w-0 flex-1`). One
class. Flexbox can now bound the column's height, the inner scroller engages,
and the composer is pinned at the bottom of the viewport. Verified live with
Playwright: Send-button bottom moved from y=1339 → y=761, clearing the bottom
bar top (y=787) with a 26px gap; desktop unchanged (`md:pb-6` = 24px only, no
mobile clearance, no excess).

**Guard:** `conversation-page.test.tsx` renders the real `ConversationPage` RSC
(heavy DB/handler/AI deps mocked) and asserts the content column carries
`min-h-0` — fails on the old `min-w-0 flex-1` markup, passes on the new.

**Watch-outs:** Any `overflow-y-auto` scroll region nested inside a `flex-col`
chain needs `min-h-0` on **every** flex ancestor between the scroller and the
height-bounded root (here: shell `<main>` → ask page wrappers →
conversation-page column → ChatShellClient root). A single missing `min-h-0`
silently disables the scroll containment and lets content overflow the viewport.
The bug hides on desktop when an intermediate breakpoint switches the axis to
`flex-row` (stretch auto-bounds height) — so always verify chat/composer layout
at mobile-portrait specifically, not just desktop.

**Linear note:** the repo `LINEAR_API_KEY` returned 401 at fix time (rotated /
expired), so the ticket could not be filed from the break-fix agent. Mac should
file the bug ticket (project oxagen-v2, label `bug` + `web-app`, assignee Mac)
and link PR for this fix.
