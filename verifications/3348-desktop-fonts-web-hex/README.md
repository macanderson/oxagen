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

`check-brand.txt` is `sync-brand-assets.mjs --check` against
`~/Projects/oxagen-brand` (kit 2.3.0). It reports drift in two files only,
`.claude/skills/oxagen-branding/Archive.zip` and `SKILL.md`. #3497 edited that
skill copy on purpose after the kit sync (ADR-113), so the check fails the
same way on main. Nothing this change touches (fonts, tokens, web assets) is
reported.
