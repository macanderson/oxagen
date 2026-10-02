# run_studio_selection

**Capability:** `run_studio_selection`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** on. The call is a governed action, and each task's model tokens bill as in-app agent spend

## Intent

A selection test checks whether a model picks the right tool for a task. Each line of a server folder's `tests/selection.jsonl` holds one task and the full name of the tool that fits it, or `null` when no tool fits:

```json
{"task":"Give the customer back $40 of charge ch_3P9 because it was billed twice.","expect":"billing__create_refund"}
{"task":"Write a haiku about invoices.","expect":null}
```

This capability runs those tests when a person asks. For each task it asks the workspace's model to pick one of the server's tools, then reports each hit and miss. No schedule, compile check, or webhook runs it, because every task is a billed model call.

The handler builds the server folder the way [list_studio_findings](tool.studio.findings.list.md) does: from the saved draft, or from the production branch when the server has no draft. The run offers each imported tool's definition from that build, as the agent receives it in `tools/list`. A description a person edited in the draft is the one the model reads, so a person can edit a description and run the tests again before Review.

The handler reads `tests/selection.jsonl` from the production branch, at the same commit as the folder. Review does not write that file, so a draft never holds it. Add or change it with a steering PR.

The model sees the task and the tool list, and answers with one tool's full name or `null`. The system prompt tells the model to treat the task and the definitions as data, never as instructions.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder the run tested |
| `basis` | `draft` or `published` | `draft` when the run offered the saved draft's tools, `published` when it offered the production folder's |
| `revision` | integer or null | the draft revision the run offered, or null for the production folder |
| `model` | string or null | the model the run asked, or null when it asked nothing |
| `counts` | object | `total`, `hits`, `misses`, `malformed`, `skipped`, and `notRun`. The last five add up to `total` |
| `cases` | array | one result per task, in file order |
| `stoppedAtDeadline` | boolean | true when the run reached its deadline before every task finished. Each task it did not finish is `not_run` |

`counts.notRun` and `stoppedAtDeadline` arrived with #5171. Both have defaults (0 and false), so a caller that reads an output without them still parses it.

Each case holds `line` (its line in the file, from 1), `task`, `expected` (the tool name, or null), and a `status`:

| status | meaning | extra field |
|---|---|---|
| `hit` | the model picked the expected tool, or picked none when none fits | `chosen`: the tool it picked, or null |
| `miss` | the model picked another tool, or picked none when one fits | `chosen`: the tool it picked, or null |
| `malformed` | the reply could not be read, or it named a tool the server does not offer | `reason` |
| `skipped` | the task expects a tool the server does not offer, so the run did not ask the model | `reason` |
| `not_run` | the run reached its deadline before the model answered this task | `reason` |

A skipped task costs nothing. Two runs can give different results, because each run asks the model again.

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role against the contract's roles before it reads anything or calls the model. An API key acts as the person who created it.

## Metering

The kernel's billing and budget gates run before the handler, as for any governed action. Each task is one call through `generateObjectFor` in `@oxagen/ai`, with the charge reason `CONSUME_ASSISTANT_TOKENS`, so its tokens are metered and charged as in-app agent spend. The model is the organization's fast model, on its funding source: the platform's key, or the organization's own, as its model funding setting chooses. The telemetry carries the surface the call came from, and the chat message id when the call came from a chat turn.

## Side effects

None in the steering repo or the draft store. Each model call writes a token usage row and a credit charge.

## Limits

- One run asks at most 50 tasks. A file with more is refused before any model call.
- The run asks up to 5 tasks at once, in file order, and starts the next task as each answer comes back. A model that takes 6 seconds a task finishes 50 tasks in about a minute.
- The run's deadline is 240 seconds, which leaves time before the 300-second limit on a request. At the deadline the run starts no new task and cuts off the calls still waiting. It returns each task that finished, marks the others `not_run`, and sets `stoppedAtDeadline`. A call cut off at the deadline gets no answer, and `@oxagen/ai` voids its usage, so it is not charged as agent spend.
- A provider may cap how many tools one request carries, such as OpenAI's 128. A server with more tools than the workspace's model takes is refused before any model call.
- Each answer is at most 1,024 output tokens.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/selection`
- MCP tool `run_studio_selection`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `folder_not_found`: the server has no draft, and the production branch has no `server.toml` for it |
| `not_found` (404) | `selection_tests_missing`: the production branch has no `tests/selection.jsonl` in the folder |
| `conflict` (409) | `selection_tests_invalid`: a line of `tests/selection.jsonl` does not parse. The message names up to three lines |
| `conflict` (409) | `too_many_tasks`: the file holds more than 50 tasks |
| `conflict` (409) | `too_many_tools_for_provider`: the server offers more tools than the workspace's model takes in one request |
| `conflict` (409) | `no_tools` or `duplicate_tool`: the folder offers no tool, or two tools share a name |
| `conflict` (409) | any refusal list_studio_findings returns when it builds the folder, such as `production_branch_missing`, `folder_invalid`, or `source_required` |
| `gau_exhausted`, `budget_exceeded` (402) | the organization's month of governed actions is used up, or a spend ceiling is reached. Either refuses the call before the handler runs |
| `invalid_input` (400) | `server` is missing or malformed, or the input carries another field |

A model call that fails for another reason passes its error through. The run starts no more tasks and waits for the calls already out. Each task that finished is still billed. A run that reaches its deadline is not an error: it returns what finished, as Limits says.
