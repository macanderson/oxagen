## Self-evaluation: proposal authority fixes, 2026-09-19

### What I set out to do
Fix the nine backlog findings in #3501 and #3502 from fresh main.

### What I actually did
Confirmed #3502 already has both implementation fixes and regression tests in #3522. Fixed the remaining creation proposal behaviors in #3501. Added YAML parsing, proposal file reconciliation, closed-branch reset, harness-specific exports, a workspace-readable repository preload, and accurate registration and validation copy.

### Quality of my decisions
- Best decision: verify fresh source before changing it. This avoided duplicating #3502.
- Weakest decision: the first YAML parser change did not reject inline merge keys. The coverage audit found that mismatch with harness YAML loaders.

### What I could have done better
- Inspect the preview and handler together before changing exported artifact paths.
- Include YAML merge keys in the initial attack matrix, alongside quoted keys and aliases.

### What surprised me
The UI already said Codex gets no subagent file while both its file preview and the handler wrote a Claude file.

### Risks left behind
Skill validation runs before proposal writes, not at merge. The UI, capability doc, and new PR body now state that limit. Registering an agent remains a separate post-merge action. Historical review replies are delegated to the parent task.

### Confidence: medium
The one local test file passes 21 tests. Other added regressions and full checks remain for CI.
