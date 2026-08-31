# Support

## Documentation

Start with the docs — they cover the platform, every capability, and the CLI:

- **Product & API docs**: <https://docs.oxagen.sh>
- **Vision & positioning**: [`docs/VISION.md`](docs/VISION.md)
- **Capability registry**: [`docs/capabilities/`](docs/capabilities/)
- **How the agent works**: <https://docs.oxagen.sh/docs/agent/overview>
- **CLI reference**: [`apps/cli/README.md`](apps/cli/README.md)

## Getting Help

| Need | Channel |
|---|---|
| Bug in the platform or CLI | [Open a bug report](https://github.com/macanderson/oxagen/issues/new?template=bug_report.yml) |
| Feature request | [Open a feature request](https://github.com/macanderson/oxagen/issues/new?template=feature_request.yml) |
| Security vulnerability | **Never a public issue** — see [`SECURITY.md`](SECURITY.md) |
| Account, billing, or anything else | `support@oxagen.sh` |

## Before Filing a Bug

1. Check existing issues for a duplicate.
2. Reproduce on the latest version (`oxagen --version`; `npm i -g oxagen@latest` for the CLI).
3. Include: what you did, what you expected, what happened, and environment details (OS, Node version, surface — web app / API / MCP / CLI).
4. For CLI issues, `OXAGEN_CLI_DEBUG=1` writes a debug log you can view with `oxagen logs` — excerpts help a lot. Redact anything sensitive.
