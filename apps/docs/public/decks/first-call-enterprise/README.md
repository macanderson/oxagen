# First-call enterprise deck

A self-contained HTML sales deck + presenter script for enterprise first calls.
Published at **https://docs.oxagen.sh/decks/first-call-enterprise**.

## Files

| File | Purpose |
|---|---|
| `index.html` | The deck. 13 slides, brand-matched to the web app (`apps/web/index.html`) — `#0B0B0C` bg, ember gradient, embedded Aeonik fonts, hex-motif chrome. Keyboard/dot/swipe nav, `⌘P` → PDF. |
| `script.html` | Standalone, printable master narration — every slide's script **plus** the full live-demo walkthrough. Openable on a second screen. Served at `/decks/first-call-enterprise/script`. |
| `script-data.js` | **Single source of truth** for all narration + demo steps (`window.OX_SCRIPT`). Both `index.html` and `script.html` load it — edit narration here and both update. |

## Presenting (off-screenshare teleprompter)

1. Open the deck and press **`S`** → a **private Presenter window** pops out, synced to the deck over `BroadcastChannel`. It shows the current slide's narration, a running timer, next-slide preview, and — on the demo slide — the numbered live-demo steps.
2. **Share only the deck window/tab** on your call (not the whole screen). The Presenter window is a separate window, so it never appears in the recording.
3. Advance with `→`/`←`, the on-screen arrows, or the Presenter's Next/Prev buttons (which drive the deck).
4. At slide 12 (**DEMO**) you leave the deck to drive the product; the Presenter/script continues through every demo step, then you return to slide 13 (**Thank you**).

## Editing

- **Narration / demo steps:** edit `script-data.js` (`window.OX_SCRIPT`) only.
- **Slide content / layout:** edit `index.html`.
- **Founder photo:** the About slide uses an `MA` monogram avatar (`.founder .avatar`); drop in a real headshot by replacing the `.mono-name` div with an `<img>`.
- The Aeonik `@font-face` blocks are copied verbatim from `apps/web/index.html`; keep them in sync if the brand fonts change.

## URL routing

`apps/docs/next.config.mjs` rewrites the clean paths (`/decks/first-call-enterprise`, `/.../script`) to the folder's HTML files so they resolve in `next dev`/`next start`. On Vercel the directory `index.html` also resolves at the clean path automatically. The Fumadocs catch-all is scoped to `/docs/*`, so `/decks/*` is never intercepted.
