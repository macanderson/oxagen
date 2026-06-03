# Project skills

Claude skills that ship with this monorepo. Each skill is a directory with a
`SKILL.md` (YAML frontmatter `name` + `description`, then the body) plus any
supporting reference files. Skills are **auto-registered** by symlinking the
directory into `.claude/skills/`, so Claude Code and every dispatched subagent
can load them on demand. They are referenced from the root `CLAUDE.md`
("Project skills").

This is the single source of truth — there is no parallel `docs/agents/` copy.

## Oxagen skills

| Skill | What it is | Reach for it when |
|-------|-----------|-------------------|
| [`oxagen-engineering-policy`](oxagen-engineering-policy/SKILL.md) | **Binding law** — non-negotiables, prime directives, four-store data model, SQL conventions, bloat/vendor/naming rules, observability, PR discipline, CI/CD (`policies/`). | **Before** writing/changing code, picking or pinning a dep, designing a schema or migration, writing tests, opening a PR, or touching CI. |
| [`oxagen-design-system`](oxagen-design-system/SKILL.md) | Oxagen brand & visual identity — palette, the indigo→green gradient ring, Aeonik type, motion tokens, glass/card, iconography, voice & casing. | Building or restyling any user-facing UI or product copy in `apps/app` / `apps/website`. |
| [`coss-ui`](coss-ui/SKILL.md) | coss ui (Base UI) component system as implemented by `@oxagen/ui` — registry & import paths, `render`-not-`asChild` composition, `*Popup`/`*Panel`/`Menu*`/`TabsTab` naming, size scales & semantic tokens, and the shadcn/Radix → coss migration mapping. | Building/reviewing UI that imports `@oxagen/ui` (`@/components/ui/*`), or migrating shadcn/Radix components to coss/Base UI. |
| [`frontend-patterns`](frontend-patterns/SKILL.md) | 136 web-platform technique guides (`techniques/`) — CSS, a11y, Core Web Vitals, forms/autofill, passkeys, view transitions, scroll animation, privacy, security, built-in AI, WebMCP. | Building/reviewing frontend — open the matching technique file(s), not the whole library. |
| [`vendor-better-auth`](vendor-better-auth/SKILL.md) | Documentation map (llms.txt index) for the Better Auth framework (`reference.md`). | Finding the right Better Auth doc page fast. |
| [`oxagen-code-audit`](oxagen-code-audit/SKILL.md) | Full-repo engineering-law audit → adversarial verify → safe auto-fix in a worktree → interactive HTML dashboard (`scripts/`). | "audit my code", "give me an audit report", "what scale/architecture problems will bite me later", scoring package health against `.agents/skills`. |

## Better Auth skills (workflow guides)

Hands-on setup companions to `vendor-better-auth`'s index:

- [`better-auth-best-practices`](better-auth-best-practices/SKILL.md) — server/client setup, adapters, sessions, plugins.
- [`email-and-password-best-practices`](email-and-password-best-practices/SKILL.md) — verification, password reset, policies, hashing.
- [`organization-best-practices`](organization-best-practices/SKILL.md) — multi-tenant orgs, members, RBAC, teams.
- [`two-factor-authentication-best-practices`](two-factor-authentication-best-practices/SKILL.md) — TOTP, OTP, backup codes, trusted devices.
- [`better-auth-security-best-practices`](better-auth-security-best-practices/SKILL.md) — rate limiting, secrets, CSRF, cookies, token encryption.
- [`create-auth-skill`](create-auth-skill/SKILL.md) — scaffold auth into a new/existing app.

## Adding a skill

1. Create `.agents/skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <kebab-case-name>          # must match the directory name
   description: <one paragraph — what it is + explicit "Use when…" triggers>
   ---
   ```
   Keep `SKILL.md` lean; push depth into sibling reference files and link to them
   (progressive disclosure).
2. Register it: `ln -sfn ../../.agents/skills/<name> .claude/skills/<name>`.
3. Add a row above and, if it changes routing, a pointer in root `CLAUDE.md`.
