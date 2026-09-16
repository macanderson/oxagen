# Visual system

Source of truth: the approved September 2026 system, reference file `w12-coverage-audit.html` in the mockups repo. `assets/tokens.css` carries the tokens; use it, do not retype them.

## Ground and surfaces

Dark first. Warm near-black ground `#10100F`, panel `#181715`, highlight `#201F1C`, borders `#292722` and `#34322D`. The parchment light theme (`#F2EEE5` ground, `#F8F5EE` panel) ships with every asset and is toggled by `data-theme` or the OS preference. Never ship a dark-only page.

## Gold

`#D6962C`, bright `#F1C364`, deep `#8B5E1A`. Gold is the identity. It appears in the mark's two accent cubes and the x of the wordmark, and on at most one action per screen. It is never a state color, never a surface fill, never a border on a card, never a highlight on a row. If a second gold thing appears on a screen, one of them is wrong.

## State by shape

Verdicts and statuses are carried by border shape, not color, so they survive grayscale, print, and the light theme unchanged.

| State | Shape |
|---|---|
| held, allowed, proven | double border, 3px |
| pending, approval | dashed border |
| broken, denied, failed | single border |

The semantic colors (`--st-allowed`, `--st-approval`, `--st-denied`, `--st-proven`, `--st-failed`, `--st-critical`) exist for badges and dots inside tables where shape alone is too small to read. They are never the only signal.

## Type

Space Grotesk for everything: headings, body, labels, buttons, tables. Weights 400 to 700. Headings at letter-spacing -0.02em, sentence case. System mono (`ui-monospace, "SF Mono", Menlo, Consolas`) for data: digests, commands, paths, frame kinds, verdict values, ids. No third typeface, ever.

Sizes on a page: h1 30 to 46px clamped, h2 24px, h3 16px, body 15px at 1.6 line height, table 13.5px, mono 12.5 to 13px, eyebrow 12px uppercase at 0.14em tracking.

## Layout

Wrap 1120px, 24px side padding. Card radius 12px. Section rhythm: 44px vertical, 1px border on top. Grid gaps 16px. Tables sit inside a rounded, bordered, horizontally scrolling container with a highlight header row.

The eyebrow above an h2 is muted, except the first one on a page, which is gold and counts as the identity, not as the action.

## Marks

`assets/logo.svg` is the oxagen wordmark with the cube cluster. The cluster's two accent cubes and the x are gold and stay gold on every background; everything else is `currentColor`. Minimum height 18px. Clear space equal to the height of one cube. Never recolor, outline, or shadow it.

Stella uses the same system with its own mark. The mark is the only difference.

## Components that exist

Header with mark and a mono tag. Sticky sub-nav. Eyebrow plus heading. Lead paragraph. Stat card (label, value, sub). Panel. Table container. Numbered method list with square mono markers. Note with a left rule. Verdict card by shape. Phase block with a gate line. Prompt box with a copy action. Toast.

Do not invent a component when one of these fits.

## Ads

Fixed canvases, same tokens, same rules. One gold action. The mark bottom left at 18 to 22px. Copy comes from the message registry at `messages/`, which generates the ad copy. `references/examples.md` shows the current directions. See `ads/` for the approved layouts.
