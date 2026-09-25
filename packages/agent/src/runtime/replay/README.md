# Assistant replay set

Each file in `fixtures/` is one assistant turn. `assistant-replay.test.ts` replays every fixture through the same composition `assistant-turn.ts` builds:

1. `materializeTools` in park mode.
2. The tool belt, with the interactive agent's capabilities pinned.
3. `runGovernedTurn` on the fake engine from `@oxagen/stella-engine-client/testing`.

The capability registry, the kernel and the ledger classification are the real ones. The fakes stand in for anything with a store behind it: the emergency-deny read, the kill-switch gate, the approval row, the IAM decision, the billing and budget gates, the tool-invocation telemetry and each capability's handler.

A turn fails when a tool is renamed, when a capability moves on or off the agent surface, when a gate is added, dropped or reordered, or when a refusal changes class.

The set runs as an ordinary unit test file, so CI runs it with the rest of `packages/agent`:

```sh
pnpm --filter @oxagen/agent test:unit src/runtime/replay/assistant-replay.test.ts
```

Do not put `--` before the path. With it, vitest drops the filter and runs the whole package.

## Fixture source

Every fixture today is hand-authored and says so in its `source` field. No `stella-serve` binary was available when the set was written, so the frames follow the shape the fake engine replays and the real server emits. They were not captured from a live turn.

`packages/stella-engine-client/src/stella-serve.smoke.test.ts` is what keeps the fake honest. It boots the binary named by `STELLA_SERVE_BIN`, drives the fake's scripted turn against it, and asserts the same facts. It records nothing.

No recorder exists yet. Every frame the client reads passes through the loop in `packages/stella-engine-client/src/client.ts` that calls `recordToFrame`. A recorder would log those frames while a real binary serves the turn, then write them into `frames` with `source` set to `recorded`.

## Fixture fields

| Field | What it holds |
|---|---|
| `turn` | A unique name. The test title is `replays <turn>`. |
| `question` | The person's message, sent as the turn's instruction. |
| `source` | `hand-authored` or `recorded`. |
| `gates` | Which gates to close. Leave it out for a turn where every gate admits. |
| `handlers` | The fake output of each capability the turn reaches, keyed by capability name. |
| `frames` | The `ServerFrame[]` the fake engine emits, in order. |
| `expect` | What the turn must produce. |

The `gates` object takes these keys:

| Key | Effect |
|---|---|
| `iamDeny` | IAM denies these capabilities. |
| `killSwitch` | These capabilities are switched off before the turn. The belt cuts them, so the model never sees them. |
| `killSwitchMidTurn` | These capabilities are switched off after the belt is built. The belt keeps them and the per-call check refuses them. |
| `gauExhausted` | The billing gate refuses with `gau_exhausted`. |
| `budgetExceeded` | The budget gate refuses with `budget_exceeded`. |

The `expect` object pins these fields:

| Field | What it records |
|---|---|
| `tools` | The tool names the model requested, in order. |
| `gates` | Every gate the turn reached, in order, as the fakes logged it. |
| `ledger` | The rows the turn ledger received: `model`, `tool` and `seal`, each with its outcome. A parked tool row carries the approval's public id. |
| `answers` | How the host answered the engine for each tool request: `ok`, `refused_by_policy` or `error`. |
| `refusals` | The error code of each failed tool call. |
| `invocations` | The tool-invocation telemetry rows: capability, status and error class. |
| `approvals` | The capabilities that opened an approval. |
| `answer` | The turn's final text. |
| `loadUnknown` | Optional. The names `load_tools` reported as unknown. |

## Frames

The fake engine pauses at each `provider_request` and `tool_request` until the host answers it.

- A `provider_request` starts one model completion. The harness reads the model's side of the turn off the frames: the `tool_start` events after a `provider_request` are the tool calls that completion asks for. The last `text` event is the turn's answer.
- A `tool_request` must name a tool on the belt. The host runs it through the real governed tool, and the fake handler answers.
- End every turn with a `turn_complete` frame.

Copy the frames from the closest existing fixture. `02-what-did-a-run-cost.json` is the smallest turn with one tool call.

## Handler outputs

A handler output must pass the capability's real output schema, or the kernel refuses it with `invalid_output`. Inputs in the frames must pass the input schema, or the kernel refuses them with `invalid_input`. Public ids have fixed shapes:

- A run id matches `^(arun|tse)_[0-9a-z]+$`. The fixtures use `arun_replay<n>`.
- An approval id matches `^apr_[0-9a-z]+$`. The fixtures use `apr_replay<n>`.

The kernel resolves the handler before the billing gate. A turn that tests billing or budget still needs a handler, or it fails with `no_handler` first.

## Gate order

The gates in a fixture's `expect.gates` read in this order:

1. `emergency_denies`, once per turn, before the belt is built.
2. For each tool call: `kill_switch`, then `iam`, then `handler`.
3. For a billed capability, `billing` and `budget` sit between `iam` and `handler`.

Two paths differ from that order:

- A write that needs approval parks before the kernel runs. It logs `kill_switch`, then `approval ... opened`, and never reaches IAM.
- The console reads (`get_run`, `get_run_cost`, `list_runs`, `list_approvals`, `get_spend`, `get_spend_drill` and `list_agents`) are `noBillingGate`. They never reach `billing` or `budget`. Fixtures 12 and 13 use `search_graph`, which is billed.

## Adding a turn

1. Copy the closest fixture to a new file. Give it the next number and a name that says what the person asked.
2. Write the `question`, the `frames`, the `handlers` and any closed `gates`.
3. Set `expect` to empty arrays and an empty `answer`.
4. Write what the turn produces into the fixture:

   ```sh
   REPLAY_UPDATE=1 pnpm --filter @oxagen/agent test:unit src/runtime/replay/assistant-replay.test.ts
   ```

5. Read the diff of `expect`. Check each tool, gate and ledger row against what the turn should do. The update writes what happened, not what is right.
6. Run the file again without `REPLAY_UPDATE`. It must pass.

`REPLAY_UPDATE` rewrites every fixture in the set, so check that no other fixture changed. The pre-commit hook reformats the JSON, so the committed file differs in layout from what the update wrote.

To see the engine posts and the stream parts behind a failure, set `REPLAY_DEBUG=1`.

Keep the set between 10 and 20 turns. One test fails when the set leaves that range or when two turns share a name.

## Known gaps

Fixtures 11, 12 and 13 pin today's behavior for IAM, credit and budget refusals. The engine is answered a plain `error`, and the ledger records `failed`. A refusal by policy should read `refused_by_policy` and `denied`. #4245 tracks the fix, and it will re-pin those three fixtures.
