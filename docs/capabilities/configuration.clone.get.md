# get_clone_draft

Read a published agent, skill, or steering configuration into an editable clone draft.

**Mode:** sync

**Surfaces:** api, mcp

Organization Owners and Admins may use this capability on every plan. API keys act as their recorded creator. The source must belong to the workspace's approved repository binding. Reads pin one production commit. Submission rejects a source that changed after the draft opened.

The default suffix is `-cloned`, then `-cloned-1`, and so on. Creation checks historical names and refuses concurrent collisions. Agent and skill proposals use exclusive branches. Steering proposals lock the new lineage before insertion. A record clone's name is its label, at most 36 characters, and only its slug has to be free, since labels can repeat (ADR-173). Cloning copies configuration only. It never copies credentials, host enrollments, live principals, or spend attribution.

The app's Clone button opens a manual editor through the workspace creation host. Edit the name, source identifier, and configuration, then submit the proposal. Publication still follows the existing proposal flow. Retiring the original remains a separate action.

See [ADR-136](../adr/ADR-136-immutable-configuration-clone-and-retire.md).
