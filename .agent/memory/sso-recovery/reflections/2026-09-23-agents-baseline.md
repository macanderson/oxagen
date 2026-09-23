## Self-Evaluation — Agents and Tools baseline — 2026-09-23
### What I set out to do
Resurface existing Agents, Tools, Mandates, and creation controls against the requirements site.
### What I actually did (measurable deltas)
Added eight agent section routes with aliases for existing links. Moved roles, budgets, and mandates into Permissions. Added a composition list using principal and credential/host counts already returned by list_agents. Moved provider registration beside connections and grants. Retained the workspace mandate ledger and auto-approval editor under their explicit names. Kept the existing creation and wrapping flows.
### Quality of my decisions
- Best decision: preserve the existing multi-measure mandate accounting and role gates while changing their placement.
- Weakest decision: initially treated the full mockup as implementation scope before the user clarified that step one only resurfaces existing functions.
### What I could have done better
- Inventory unique existing functions and confirm placement before changing navigation.
- Read the catalog-used invariant before editing translation keys, so obsolete keys are removed in the first pass.
### What surprised me about this codebase/product
The list handler already returned principal, active credential, and active or paused host counts that the app mapper discarded. The Tools page also had a working mandate ledger and approval rules that the mockup's policy-version panel did not represent.
### Risks I am leaving behind
The reusable toolbelt catalog, assembled steering preview, per-agent token rollup, and versioned policy editor remain absent. Adding their stores is outside the approved resurfacing step. Runtime records remain the enrolled hosts the current app already reads.
### Confidence in the result: medium
Existing action components and handler gates are reused. Component tests cover the new navigation and retained actions. CI and the root agent's live UI verification remain required; no local tests or suites were run.
