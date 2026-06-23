---
name: flex-min-h-0-scroll-chain-footgun
type: observation
domain: web-app
severity: P3
date: 2026-06-23
---

**Observation:** The `apps/app` chat/ask layout relies on a long
`h-full` + `flex-col` + `overflow-y-auto` chain to keep an internal message
scroller and a bottom-pinned composer inside the viewport. The chain is fragile:

```
shell <main> (overflow-y-auto, max-md bottom-bar pad)   shell-frame.tsx
└ ask/page.tsx        flex h-full min-h-0 flex-col
  └ min-h-0 flex-1
    └ conversation-page.tsx   flex h-full flex-col md:flex-row   ← axis flips at md
      └ content column        min-h-0 min-w-0 flex-1            ← needs min-h-0
        └ mx-auto h-full max-w-4xl
          └ ChatShellClient    mx-auto flex h-full flex-col
            ├ messages scroller  min-h-0 flex-1 overflow-y-auto
            └ MessageComposer (bottom-pinned)
```

For the inner `overflow-y-auto` to contain instead of overflow, **every** flex
ancestor on the column path needs `min-h-0` (flexbox default `min-height: auto`
refuses to shrink a flex item below its content). Miss one and the scroller
silently disables; content grows past the viewport and the composer falls below
the fold / behind the `MobileBottomBar`.

This is doubly error-prone because `conversation-page` flips its axis to
`md:flex-row` on desktop, where `align-items: stretch` auto-bounds item height —
so a missing `min-h-0` is **invisible on desktop** and only breaks on mobile
portrait. Two separate padding/clearance bugs (#126 desktop excess pad; OXA-1814
mobile composer occlusion) both lived in this same chain within days.

**Rule of thumb:** when touching any layout in this chat/ask chain, verify at
mobile-portrait (e.g. 390×844) with the `MobileBottomBar` present, and confirm
the message area scrolls internally while the composer stays pinned above the
bar. Don't trust a desktop-only check. The bottom-bar geometry tokens live in
`globals.css` (`--bottom-bar-h`, `--bottom-bar-gap`); the shell `<main>`
reserves mobile clearance via
`max-md:pb-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap)+env(safe-area-inset-bottom))]`.
