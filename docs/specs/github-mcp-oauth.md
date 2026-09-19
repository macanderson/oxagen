# GitHub MCP OAuth implementation reference

The former July 2026 operator runbook used Workbench and `/api/v1/mcp/oauth/authorize` in the pre-rebuild app. That route is absent from the current app. Its setup instructions and Vercel deployment steps have been removed because they cannot establish a working connection in the current app.

The shared OAuth implementation remains in [packages/plugins/src/oauth](../../packages/plugins/src/oauth/). Read [the database-backed provider](../../packages/plugins/src/oauth/db-oauth-provider.ts) and [pre-registered client configuration](../../packages/plugins/src/oauth/preregistered-clients.ts) when working on MCP authorization.

A configured OAuth client does not supply a missing authorization or callback route. Verify the consuming surface and provider metadata before restoring an operator procedure.

For Google or GitHub account sign-in, use [the social login checklist](social-login-oauth-apps.md). Account sign-in, the GitHub data connector, and MCP authorization are separate flows.
