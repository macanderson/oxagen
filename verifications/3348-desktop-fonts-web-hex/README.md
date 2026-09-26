# #3348 desktop fonts and web hex texture

Captured 2026-09-25 on branch `fix/desktop-updater-fonts-entitlements`.

## Desktop masthead

`desktop-masthead.png` is the desktop UI served by `vite` on a spare port and
opened in headless Chromium at 600 by 760, the window's default size. The
desktop app itself was not launched, because this machine runs a live
enrollment. The red banner is the UI failing to reach the Tauri bridge, which
a browser does not have.

`desktop-fonts.json` is what the page reported: the body resolves to Geist,
the wordmark to Space Grotesk, and both faces loaded from
`@oxagen/ui/styles/house-fonts.css`. Monaspace Neon loads on the first code
element, and this screen has none.

## Web hero

`web-hero-dark.png` is `apps/web/index.html` served from the source tree and
opened in headless Chromium at 1280 by 800 with `data-theme="dark"`. The hex
constellation strokes in white on obsidian. The computed `::after` background
of `.tex-hex` carried `%23FFFFFF`.

## pnpm check:brand

`check-brand.txt` holds two runs of `sync-brand-assets.mjs --check`, the
script behind `pnpm check:brand`.

- Against the kit's committed tip (`oxagen-brand` at 8f2fd84, extracted with
  `git archive`): every vendored asset matches house kit 2.3.0, exit 0.
- Against the local working copy at `~/Projects/oxagen-brand`: exit 1, on
  `.claude/skills/oxagen-branding/Archive.zip` and `SKILL.md` only. That
  checkout carries uncommitted edits to `skills/oxagen-branding`, so the
  failure is local to this machine and fails the same way on main.
