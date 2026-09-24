# Oxagen Desktop

`spec.md` is the specification of the desktop app (`apps/desktop`): the
installer for macOS, Linux, and Windows that wraps Claude Code and Codex under
Tacho, signs a machine in to an organization, and manages the workspace the
host reports to. `spec.html` is the same document rendered in the house shell
(`docs/specs/_house/`); open it in a browser, or read the shared copy:

- Artifact (rev 1, 2026-09-13): https://claude.ai/code/artifact/41070634-87a0-4537-b663-031b6b86297e

Related specs: `docs/specs/tacho/spec.md` (the wrapper), `oxagen-roadmap:docs/oxagen/specs/tacho/plan.md`.
When the app changes, edit `spec.md` here, run
`python3 docs/specs/_house/render.py docs/specs/oxagen-desktop/spec.md`, and
republish the artifact from the result; the repo copy is the source.
