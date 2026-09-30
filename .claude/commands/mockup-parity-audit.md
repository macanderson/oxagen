---
description: Audit this app against the mockup in oxagen-roadmap, the design of record, for every page or the pages you name; fix the confirmed gaps in one pull request, file the rest, and write a branded report in the roadmap's audits/
argument-hint: "[page path | description of pages] (empty audits every page)"
---

# /mockup-parity-audit

Arguments: $ARGUMENTS

The command lives in macanderson/oxagen-roadmap, beside the mockup it holds this app to. Check it out
beside this repository (`~/Projects/oxagen-roadmap`, or `../oxagen-roadmap` in a cloud session), then
read `oxagen-roadmap:.claude/skills/mockup-parity-audit/SKILL.md` and follow it with the arguments
above. `oxagen-roadmap:<path>` means `<path>` in that checkout.

Read `docs/adr/ADR-226-the-v3-mockup-and-the-brand-kit-are-the-design-of-record.md` here first. Its
pin names the commit the audit reads the mockup at.

What runs where:

- The page registry, the audit prompts, the protocol, and each run's folder (`audits/<yyyy-mm-dd>_<scope>/`,
  with every page's `before.png`, `after.png`, and `findings.md`) live in the roadmap.
- The fixes ride one pull request in this repository, with an issue for each code change, under this
  repository's rules in `CLAUDE.md` and `AGENTS.md`.
- The captures of this app come from `.github/workflows/mockup-parity-capture.yml`, because nothing
  here is built or served on the maintainer's machine.
