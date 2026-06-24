# app.oxagen.sh — Production UI Audit (2026-06-24)

Read-only audit of the production app, run via `playwright-cli` against an authenticated session.

## Deliverables
- **[AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md)** — verified bugs (5), full live/preview page inventory, form-test summary, and a methodology caveat about crawler data-quality.
- **[PREVIEW-PAGE-SPECS.md](./PREVIEW-PAGE-SPECS.md)** — build spec for each of the 15 preview pages (mapped to shipped contracts), the Access/IAM epic, don't-build recommendations, and feature/repurpose suggestions.
- **[screenshots/](./screenshots/)** — 53 PNGs, one per route (filenames match the labels used in the reports).

## TL;DR
- **5 bugs.** P1: `knowledge/nodes` is a hard 404. P2: all 7 `access/*` pages silently redirect to `/ask` (IAM section unbuilt). P3: epoch `1/1/1970` date on empty graph, global React #418 hydration error, `developer/tokens` has no create-UI.
- **15 preview pages** ship a "not yet wired" banner. **6 have their backend fully shipped** (activity/audit, approvals, automation/triggers+playbooks, studio/compose, knowledge/memories) and are near-pure UI wire-ups — start there.
- **Biggest opportunity:** Studio (Compose + Library) — the entire generation backend is shipped but hidden behind preview banners.
- **Don't build natively:** `security/incidents` (integrate, don't rebuild PagerDuty). **Trivial fix:** `developer/docs` (drop the misleading preview banner, link to docs.oxagen.sh).
- **A peer-session data-quality note:** two parallel crawlers raced on a shared config file and one fabricated a "redirect everything to security" finding — **all those routes were hand-re-verified and are live**. See AUDIT-FINDINGS.md.

## Reproduce
Auth state is saved in `auth.json` (httpOnly session cookie) and `pw.config.json` points playwright-cli at bundled chromium. To re-open:
```
playwright-cli -s=audit open --config="$PWD/pw.config.json" about:blank
playwright-cli -s=audit state-load "$PWD/auth.json"
playwright-cli -s=audit goto "https://app.oxagen.sh/thomas-anderson-mac/default/ask"
```
