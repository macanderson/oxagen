# `get_run_issue_providers`

Read issue provider connections and optionally list authorized Linear teams.

**Surfaces:** api, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

Requires an organization Owner or Admin. Authorization and provider requests require explicit Run follow-through consent and refuse platform suspension. No AI credits are consumed by authorization or connection status.
