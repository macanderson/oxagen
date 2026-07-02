# Unified Agent Engine

This package powers the agentic engine built inside of Oxagen including the Oxagen web app and Oxagen cli tool.

**Directories:**

- **evaluate:** LLM judge agent controls
- **fleet:** Multi-agent deployment controller.
- **internal:** Agent utilities like globToRegex().
- **pipeline:** The turn pipeline — what every user prompt flows through.
- **prompt:** System prompt builder.
- **planner:** Task planning and session management.
- **router:** Cost-aware model routing for the agent engine.
- **trace:** Log writing/outputs and session state management.
- **workspaces:** Workspace memory writer/recaller

If you are writing code related to anything that touches the agentic process in Oxagen 99% chance it should live here.
