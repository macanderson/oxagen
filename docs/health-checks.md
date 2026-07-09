> PROMPt: FINISH THIS DOCUMENT AND INFER MY DESIRED OUT COME FROM MY DRAFT COPIED HERE BELOW:

# Health Checks

I want to ship slash commands for checking the health of a code base/repository.

I want to leverage the information contained in the code graph and use as much deterministic approaches as possible to save on token burn to identify and score 1 to 100, 100 being the healthiest a code base could possibly be.

Dead code, swallowed errors, unhandled exceptions, insufficient login, not implemented erros, @todo/todo to-do grep, github issues/linear issues review, ci/action logs, error logs last 24 hours, project code graph and related queries.

And I want to be able to run /repo-audit [all|list of auditors]

## Auditor Agents

Read/Write agents equipped with all tools/no restrictions charged with evaluating a area of concern across the entire code base and AFTER fixing P0|P1 issues reporting the new score/post-fix.

List areas of concern we need 12-24

Develop a list of prompts to use that make heavy use of deterministic queries to limit token burn during the audit process. We need to lean into the code graph tool heavily for this.

List of memories/information schemas to store in the code graph to help facilitate future bug fixes/feature implementations/refactors etc...

An auditor is a series of functions perhaps involving an LLM helper that covers a specific slice of areas of concern like "swallowed errors" "dead code" etc...

Please write a list of at least 10 areas of concern a code base should care about when trying to understand its production readiness.

## Prompts for AI agents equipped with code graph tools

We need to expand on these prompts and develop a list of 25-50 prompts I can use to automate a comprehensive code base health check with minimal llm calls and maximum results.

- Using codegraph, find patterns of 'god objects' where a struct has more than 15 methods.
- Show me all public functions that are not called by any other function in the workspace."
- Find all circular dependencies between modules
