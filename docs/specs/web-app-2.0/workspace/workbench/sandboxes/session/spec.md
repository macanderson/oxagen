---
# Sandbox Session

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/sandboxes/[sessionId]`
- **Nav location:** workspace → Workbench → tab "Sandboxes" → row click
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
An interactive view into one durable sandbox session — a terminal for running commands and a file browser for inspecting workspace files — so a builder can debug or drive an agent's execution environment directly.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / developer
- **JTBD:**
  - Run ad hoc commands in the sandbox and see live output
  - Browse and read files inside the sandbox filesystem
  - Snapshot the sandbox state before making a risky change
  - Stop the session when done to free the resource

## Functionality
- Split layout: terminal pane (command input + streamed output) and file browser pane (tree + file preview).
- Header: session status, template, started-at; "Stop" action.
- File browser: navigate directories, open a file to read its contents inline.
- Workspace-scoped 404: a session ID belonging to another workspace renders not-found rather than leaking cross-tenant data.

## Capabilities invoked
- `agent.sandbox.exec` (`run_sandbox_command`) — terminal command execution.
- `agent.sandbox.stop` (`stop_sandbox`) — Stop action.
- `agent.sandbox.snapshot` (`snapshot_sandbox`) — snapshot action.
- `agent.sandbox_file.list` (`list_sandbox_files`) — file tree.
- `agent.sandbox_file.read` (`read_sandbox_file`) — file preview.
- Note: `browser.*` capabilities are agent-driven inside the sandbox during autonomous runs, not invoked from this human-facing UI.

## Data sources
Sandbox driver (live session/terminal/file state) + Blob storage (snapshots and captured assets).

## States
- **Empty:** file browser shows an empty workspace root if nothing has been written yet.
- **Loading:** terminal shows a connecting indicator; file tree shows a skeleton while `list_sandbox_files` resolves.
- **Error:** workspace-scoped 404 for a foreign/invalid session ID; command execution errors render inline in the terminal output stream, not as a page-level error.

## Existing implementation
- **Today:** COMPLETE — interactive terminal and file browser both wired, workspace-scoped 404 enforced, Stop action functional.

## Vision alignment
Direct visibility into the metered execution substrate underpinning agent runs — every command here is a governed, billable action tied to the owning agent's accountability chain.
