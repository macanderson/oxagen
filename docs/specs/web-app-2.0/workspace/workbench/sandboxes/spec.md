---
# Sandboxes

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/sandboxes`
- **Nav location:** workspace → Workbench → tab "Sandboxes"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
The list of durable sandbox sessions available to run agent code and commands in this workspace, plus a "warm a sandbox" control to pre-start one ahead of an agent run. Honest about the case where no sandbox driver is configured rather than pretending the feature works.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / developer running code-mode agents
- **JTBD:**
  - See all active/recent sandbox sessions in this workspace
  - Open a session to inspect its terminal and files
  - Pre-warm a sandbox before kicking off a run, to cut cold-start latency
  - Understand immediately if the sandbox driver isn't configured for this environment, instead of hitting a silent failure

## Functionality
- Table: Session ID · Status (starting/running/stopped) · Template · Started at · Last active; row click → session detail.
- "Warm a sandbox" panel: template picker, Start button.
- Unavailable banner (when driver unconfigured): explicit message plus link to environment/driver setup docs — no dead spinner.

## Capabilities invoked
- `agent.sandbox.list` (`list_sandboxes`) — populate the table.
- `agent.sandbox.start` (`start_sandbox`) — warm-a-sandbox action.

## Data sources
Postgres (sandbox session records) + sandbox driver (session runtime state).

## States
- **Empty:** no sessions yet — warm-a-sandbox panel front and center.
- **Loading:** table skeleton while `list_sandboxes` resolves.
- **Error:** driver-unconfigured state renders as an explicit unavailable banner, not an error toast; transient list failures get inline retry.

## Existing implementation
- **Today:** COMPLETE — durable sandbox session list and warm-a-sandbox panel wired; unavailable state handled honestly when no driver is configured. Reverse-parity note: `list_sandboxes` and `start_sandbox` are invoked here but both contracts omit `app` from `layers[]`, a gap `check:ui-parity` flags advisory-only — add `"app"` to both `layers[]` to close it.

## Vision alignment
Sandboxes are the metered execution substrate under agent runs — every session here is a billable, governed unit of compute tied back to an agent's accountability chain. P2: important build-time infrastructure, not the primary run surface.
