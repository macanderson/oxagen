# Unified Agent Engine

This package powers the agentic engine built inside of Oxagen including the Oxagen web app and Oxagen cli tool.

**Directories:**

- **evaluate:** LLM judge agent controls
- **fleet:** Shared task/plan/snapshot types (the orchestrator itself lives in the CLI).
- **internal:** Agent utilities like globToRegex().
- **lifecycle:** Wall-clock and memory-ceiling guards for long-lived agent processes.
- **localize:** Zero-token candidate-file localization from the code graph.
- **memory:** Relevance filtering for retrieved memory items before they reach the prompt.
- **oracle:** Hypothesis extraction and probe-command pairing from agent transcripts.
- **pipeline:** The turn pipeline — what every user prompt flows through.
- **prompt:** System prompt builder.
- **planner:** Task planning and session management.
- **priors:** Per-repo procedural knowledge (test commands, layout, conventions) persisted across runs.
- **router:** Cost-aware model routing for the agent engine.
- **speculate:** Speculative, read-only tool prefetching while the model is still thinking.
- **tools-structured:** Deterministic diagnostic tools (test/build/diff) that replace raw `bash` output parsing.
- **trace:** Log writing/outputs and session state management.
- **verify:** Mutation-testing gate that checks a fix's tests actually fail without the fix.
- **workspaces:** Workspace memory writer/recaller

If you are writing code related to anything that touches the agentic process in Oxagen 99% chance it should live here.
