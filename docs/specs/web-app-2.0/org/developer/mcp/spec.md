---
# Developer — MCP Connect

- **Route:** `/{orgSlug}/developer/mcp`
- **Nav location:** org → Developer → tab "MCP"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
This page gets a developer from zero to a working MCP connection in under a minute — pre-filled, copy-pasteable configuration snippets for the tools they already use (Claude Code, Claude Desktop, Cursor), using the org's own API key. It is the concrete proof point of capability parity: the same governed, typed contracts reachable over MCP as over the API and app.

## Primary user & jobs-to-be-done
- **Primary user:** Developer integrating Oxagen into an AI coding tool
- **JTBD:**
  - Get a ready-to-paste MCP config for my client of choice without hunting docs.
  - Confirm which API key is being used (masked, so I know which credential is live).
  - Know the real connection endpoint without guessing at URLs.
  - Understand what to do if I don't have an API key yet.

## Functionality
- **Client tabs/sections:** Claude Code, Claude Desktop, Cursor (extensible to more MCP clients) — each with a syntax-highlighted (Shiki) config snippet ready to copy.
- Snippets are injected with the org's first active API key, masked (e.g. `sk-...ab12`), and the real MCP endpoint (`mcp.oxagen.sh/mcp`).
- **No-key fallback:** if the org has no active API key, the page shows a clear CTA to create one (linking to the Tokens tab) instead of a broken snippet.
- Copy-to-clipboard action per snippet.

## Capabilities invoked
- `system.install.instructions` (`get_install_instructions`) — generates the client-specific config text.
- Direct DB read for the org's active API key (masked).

## Data sources
Postgres (API key table, masked read).

## States
- **Empty:** no active API key → no-key fallback CTA replaces the snippets entirely.
- **Loading:** skeleton snippet blocks while install instructions + key lookup resolve.
- **Error:** install-instructions fetch failure falls back to a static generic snippet with a note to fill in the key manually.

## Existing implementation
- **Today:** COMPLETE — injects the org's first active API key (masked) into Claude Code/Desktop/Cursor snippets, Shiki-highlighted, real endpoint URL (`mcp.oxagen.sh/mcp`); graceful no-key fallback. Reuse as-is.

## Vision alignment
Capability parity in action — the same governed contracts reachable over MCP, connected via a BYOK-neutral credential. P2 because it's a developer-experience surface on top of an already-solid parity guarantee, not a new wedge capability.
