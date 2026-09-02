# Unified Agent Engine

This package is the agent engine behind Oxagen. The web app and the `oxagen`
CLI both run their agent turns through it.

**Directories:**

- **evaluate:** Everything a model is asked to judge — prompt triage, the
  completeness judge, best-of-N candidate selection, diff-consensus, structured
  diagnosis, and prompt enhancement.
- **fleet:** Shared task/plan/snapshot types (the orchestrator itself lives in the CLI).
- **fork:** Cache-forked best-of-N — snapshot the shared "trunk" of a
  conversation, then plan one tail per root-cause hypothesis.
- **internal:** Small shared helpers, e.g. `globToRegExp()`.
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
- **workspaces:** `MemoryWorkspace` — an in-memory implementation of the
  `Workspace` port, so tests and sandbox-free callers can run a turn with no
  disk and no shell.

The files directly in `src/` are the engine's own surface: the tool loop
(`engine.ts`, `loop-driver.ts`), the injected ports (`ports.ts`, `types.ts`),
the tool set (`tools.ts`, `tools-shared.ts`), and the guards that wrap tool
calls (`dispatch-guard.ts`, `edit-integrity.ts`).

If you are writing code that touches the agentic process in Oxagen, it almost
certainly belongs here.
