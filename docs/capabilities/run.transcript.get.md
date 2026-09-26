# get_run_transcript

One run read as a transcript at one of three zoom levels (Mission Control spec §8.4, §14 "the transcript at three zoom levels (turns, steps, everything)"; ADR-058). The transcript is derived on the server from the frames and the bodies the recorder kept; nothing is stored.

A wrapped run's subagents record on chains of their own. The transcript reads every chain under the run's root session and places each subagent chain directly after the `subagent_start` that spawned it. An entry from a subagent chain carries `subagent`, and its body halves and decisions carry `sessionUuid`, because a subagent chain numbers its frames from 0 like the run's. `get_run_frame_body` reads the run's own chain only.

The cursor is opaque. It names two frames: the opening of the last entry sent, and the latest frame any page has delivered. An entry whose frames grew past that second frame since it was sent (a step that gained its result, a turn that gained a step, a Task call whose subagent recorded more) is sent again once, ahead of the new entries, and no entry after it is sent again (#4048). A reader keeps each entry once by its opening frame, `seq` together with `subagent.sessionUuid`, and replaces a copy it holds with the one sent again. A cursor written before the two-frame form, which names one frame, is still accepted.

A page reads a bounded range of the run's frames rather than the run from the cursor to its end, and a subagent chain is read by its `session_uuid` from the list Postgres keeps, so a read's cost does not grow with the workspace. A whole-run reader pages at the largest `limit` the contract allows. The Cost tab's per-turn ledger is `get_run_turns`, which counts every frame of the run in one grouped read rather than paging this one (#4067).

A body the store cannot return reads as `text: null` on its half; the rest of the page is still answered.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/transcript`
- MCP: `get_run_transcript`
- CLI: none
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `get_run_transcript`
- Not billed (`noBillingGate: true`): reading a recording is a console read (ADR-052 exclusion 2). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |
| `zoom` | `turns` \| `steps` \| `everything` | yes | |
| `kinds` | string[] | no | the chips pressed; empty (the default) keeps every frame |
| `after` | string | no | an entry cursor from an earlier read |
| `text` | `excerpt` \| `full` | no | how much of each body to carry; omitted takes the zoom's cap (see below) |
| `query` | string | no | words to search the entries for, ignoring case; trimmed, 1 to 200 characters (see Search) |
| `limit` | integer | no | 1–500, default 200 |

## Zoom levels

- `everything`: one entry per frame, so the two halves of a step are two entries, each with its own body. A decision frame is its own entry, with kind `policy`.
- `steps`: one entry per model call (`model.call_completed`, `model.engine_call_started`, `model.engine_call_completed`, `llm_call`, `model.request`, `model.response`) and per tool call (`tool.call_completed`, `tool.engine_call_started`, `tool.engine_call_completed`, `tool_call`, `tool_requested`), with the request half and the response half folded into one entry, and one entry per event: a prompt, a reply, a decision on no recorded call, a recall, the run's stop. A run of identical frames with nothing to read on them (a harness registering its hooks) is one entry. A step never crosses a turn boundary.
- `turns`: the `steps` entries grouped by the turn they fall in, so the two zooms agree on what a turn holds. A turn opens at each `turn_start` frame; when the recording carries no turn boundaries, wherever the frames' turn index changes, taking with it the context and model frames recorded just before the call that carries the new index; a run with neither is one turn. The frames before the first turn are one entry of their own.

The server is the only place a transcript is folded (ADR-182). A client presents the entries it is sent and does not pair, group or count frames of its own. Before ADR-182, `steps` folded every frame that was not a call half into the step before it, so a turn's prompt sat inside the previous turn's last call; a caller that counted `steps` or `turns` entries sees different counts now. The response shape only gained fields.

### How frames become steps

Within one turn, frames are taken in order, and each frame no earlier step claimed opens a step:

1. A frame that carries a call id and is not a model frame gathers every frame with the same `callId` on its chain, when one of them is a tool frame. A wrapped Claude Code session writes several frames for one tool call, often not adjacent: Oxagen's gate decision, the hook's request, the harness's own permission check, the receipt, and digest-only copies from other sources. They are one step, which opens on the earliest of them.
2. A model request pairs with the next response of its spelling that no other request took: on the call id where the request has one, else the frame right after it. So two requests sealed under one id pair with the two responses in order (#3994).
3. A tool request with no call id takes the gates right after it that name no call either, and the receipt with no call id that closes it.
4. A lone model or tool frame is a whole step.
5. A run of identical frames with nothing to read on them is one step.
6. Any other frame is its own step.

A tool step also takes the effect frames (`command`, `file_io`, `network`) right after it that name its call, or that name no call when the step names none either.

A step's `request` is its first request frame and its `response` the first frame that came back, each preferring a copy whose body was kept over a digest-only one. A producer that appends a single terminal receipt for the whole exchange records it as the `response`, because its body is the result, and `request` is then null. A `turn_start` that kept the operator's words carries them as its `request`, and a `turn_end`, or a message a harness reported apart from it, carries its words as its `response`.

Claude Code's own permission check (`tool_decision` and `tool.blocked_on_user` in its OTel log) is recorded as `harness_permission`, not `policy_decision`. It runs on every call and is not a decision a rule made, so it answers to no chip. A row stored before this kind existed, as a `policy_decision` from `otel_log` or `otel_span` with `policy_source: harness`, reads as `harness_permission` too.

## Chips (`kinds`)

Each chip selects what the Run page's Transcript tab draws under it, so the count `counts.kinds` gives a chip is the count of what that chip shows (ADR-182).

| Chip | Frames it selects |
|---|---|
| `prompt` | the `turn_start` an operator typed to open a turn. A subagent's `turn_start` and the `oxagen:message` copies of the same prompt are not counted, so each prompt counts once. The request half of a model call is the context the model was sent and answers no chip |
| `responses` | the response half of a model call, or a single model receipt, whose body was kept; or a reply the harness reported with its words kept: a `turn_end`, or an `oxagen:message` recorded as a response. The Run page draws a row under this chip for every model step that answers it: what the model said, or a line naming what it called when it said nothing in words. A model response kept as a digest alone answers `usage` when it carried a cost, tokens or an effort, and no chip otherwise |
| `thinking` | a model call whose usage records reasoning tokens. A wrapped session records them from Claude Code's `thinking_tokens`; a duplicate sighting of the same call carries no usage and is not counted |
| `tools` | either half of a tool call |
| `policy` | a decision a rule or a person made: allow, deny, route, and an operator's pause, resume, cancel or steer as the host applied it (`oxagen:command_applied`) |
| `recall` | what was pulled into the model's context |
| `usage` | a frame that carried a cost record or token counts the provider reported without one, or a model call that recorded the reasoning effort it ran at |
| `seal` | the run's own stop: the wrapped agent's `agent_stop` on the run's own chain, or the ledger event that closes an attempt. A `checkpoint` and a `telemetry_gap` are the chain's own, read with `get_run_chain`, and answer no chip |
| `errors` | a call whose recorded outcome is failed, denied, cancelled, error, timeout, refused or rejected |

The fold runs over every frame first, and the filter then keeps the entries that answer a chip pressed. A filtered transcript therefore shows the same steps as an unfiltered one, only fewer of them: a `policy` selection at `steps` keeps each governed tool call whole, with both halves. At `everything` the answer is the same as filtering frames. An empty selection keeps everything: no chip pressed is not the same as every chip pressed off.

The run page mockup (`mockups/pages/run.md`) draws the same chips in the order `TRANSCRIPT_KINDS` lists them. `policy` is not among the mockup's chips; it stays a kind because the Policy tab reads it, and the app files it under the tools chip. The contract has no `none` kind. The app's `kinds=none` query opens the Transcript tab with every chip off. The tab hides and shows the rows of the whole-run read the page already made, so no chip setting reads again, and each chip's count is `counts.kinds` from that read.

## Output

| Field | Type | Description |
|---|---|---|
| `zoom`, `kinds` | string, string[] | as asked |
| `entries` | object[] | at most 500 |
| `entries[].seq`, `endSeq` | string | the frame that opens the entry and the last frame folded into it |
| `entries[].at` | string | RFC 3339, the opening frame's observation |
| `entries[].elapsedMs` | integer | milliseconds from the run's recorded start; clamped at zero |
| `entries[].kind` | `turn` \| `model_call` \| `tool_call` \| `policy` \| `frame` | |
| `entries[].type`, `label` | string | the opening frame's recorded type and its machine-derived label |
| `entries[].callId` | string or null | the call the opening frame belongs to (`tool_call_id`, `model_call_id`, or a wrapped `toolUseId`); null when the producer recorded none. A client reads steps at the `steps` zoom rather than pairing `everything` entries on this value (ADR-182) |
| `entries[].kinds` | string[] | the chips this entry answers to |
| `entries[].target` | string or null | what Oxagen's gate recorded the call acting on (`tool_target`: a command, a path, a pattern), cut at 400 characters; absent when the gate recorded none |
| `entries[].effort` | string or null | the reasoning effort the model call ran at (`low`, `medium`, `high`), as the harness recorded it on `tacho_events.effort`; null when none was recorded |
| `entries[].subagent` | object or absent | on an entry from a subagent chain: `{ sessionUuid, id, type }`, plus `spawnCallId`, the `tool_use_id` of the Task or Agent call that spawned it, and `parentSessionUuid`, the chain that spawned this one. A client nests the entry by `parentKey` |
| `entries[].request` | object or null | what went out; null when the recording has only the terminal receipt |
| `entries[].response` | object or null | what came back; null when only a write-ahead intention was recorded |
| `entries[].{request,response}.seq`, `.type` | string | the frame that carried the half |
| `entries[].{request,response}.digest`, `.bytesRef` | string or null | the recorded digest, and where the bytes were retained |
| `entries[].{request,response}.redactions` | object[] | what was removed before the body was written |
| `entries[].{request,response}.fidelity` | `full` \| `digest_only` | so a `digest_only` recording says so on every half |
| `entries[].{request,response}.text` | string or null | the body as UTF-8, cut at the zoom's cap (see below); null when no body was retained, the body is not text, the frame carried no content, the stored bytes do not hash to the recorded digest, or the half carries an `assembly` instead |
| `entries[].{request,response}.truncated` | boolean | true when `text` was cut |
| `entries[].{request,response}.assembly` | object or null | a recorded model stream folded into the message it was; null for every other half |
| `entries[].decision` | object or null | `{ seq, decision, type, source, harness, at }`, the decision folded into the entry. An operator command records the command as `decision`. `source` is who decided, in the envelope's `policy_source` words: `bundle` or `kernel` for Oxagen policy, `human` for an operator, `harness` or `managed_settings` for the agent's own harness; null when the frame names none. `harness` is true when the source is the agent's harness checking itself and false otherwise, including when the source is unrecorded. A reader sorts decisions on `harness`, not on its own list of source words. An operator command is its own entry at `steps`, and at `turns` it is never the turn's decision, because it is about the run and not about any one call |
| `entries[].frames` | integer | frames folded, the opening frame included |
| `entries[].turn` | integer or null | the turn the opening frame belongs to, 1-based, the same at every zoom and under every chip filter. A recording with `turn_start` frames counts them, and a frame before the first one is in no turn (null). A recording without them starts a new turn wherever the turn index changes, and every frame is in one. The ledger writes the index only on `model.call_completed`, so the context and model frames recorded just before that call belong to its turn, while the tool frames after the previous call stay in the previous turn. A client groups `everything` entries into turns by this value |
| `entries[].cost` | `{ micros, currency, basis }` or null | the folded frames' cost records summed; null when none carried one. Ledger frames carry no cost record; spend is metered per run |
| `entries[].cumulativeCost` | `{ micros, currency, basis }` or null | every cost record of the run up to and including this entry (spec §8.4 prefix sum), so a page never restates the run's spend as the page's |
| `cursor` | string or null | the point to continue from; null when nothing lies past this page |
| `complete` | boolean | false when the run has more than 10 000 frames, so the transcript is a prefix |
| `counts` | object | the run's entries at the zoom read, counted over every entry that is not `quiet`, whatever the chips or query: `kinds` (entries per chip), `entries`, `errors` (entries that failed or were refused, or answer the errors chip), and `policy` (entries that answer the policy chip, except the harness checking itself). A quiet entry draws no row, so no count holds it. The unit is the entry: a model step that said two things counts once. At `everything` the words are not read (see Words), so there a prompt or reply whose words are blank or repeat still counts |
| `counts.frames` | object | the same counts at `everything`, where each frame is its own entry, at every zoom: `kinds.policy` and `kinds.recall` (frames those chips keep) and `policy` (the decisions among them a rule or a person made). A reader that lists decisions or recalls frame by frame counts them from any read, so the Run page reads `steps` once and takes its tab badges from it. They need no words: only a prompt or a reply can turn quiet on its words, and neither is a policy or recall frame |
| `figures` | object | the run's steps, calls and recorded time, whatever the zoom, chips or query (see Figures) |
| `search` | object or absent | on a read with a `query`: `{ query, matched, unsearched }` (see Search) |
| `entries[].matches` | string[] or absent | on a read with a `query`: where the entry matched, from `label`, `subject`, `target`, `request` and `response` |

### What the fold states about each entry

The server is the only place a transcript is folded (ADR-182), so every fact a reader would otherwise derive from an entry's frames is a field of the entry. Each is optional in the schema so an older answer still parses; this handler always sends them. None of them is written into `label` for a client to parse.

| Field | Type | Description |
|---|---|---|
| `entries[].key` | string | the entry's name within the run: the opening frame's `seq` on the run's own chain, `<sessionUuid>:<seq>` on a subagent's. Stable across reads |
| `entries[].parentKey` | string or null | on a subagent's entry, the `key` of the entry that spawned its chain: the call whose `tool_use_id` the chain names, or else the latest entry on the parent chain that recorded a `subagent_start`. Null on the run's own chain |
| `entries[].node` | string or null | what kind of row the entry is: `prompt` (the operator's words), `reply` (a `turn_end` or a message the agent reported), `model`, `tool`, `policy` (a decision on no recorded call, or an operator's command), `recall`, `seal` (the run's own stop), `control` (a frame that frames the run, such as the agent starting), or `event`. Null for a turn |
| `entries[].quiet` | boolean | true when the entry has nothing to show beyond its frames: a prompt or reply with no words to show (no body kept, or a body read whole that holds only whitespace), a reply that repeats words just shown (`echoOf`), a model step that kept no reply, carried no cost, tokens or effort, and did not fail (a call still waiting on its reply is one), or an event with no decision and no failure. A body that could not be read leaves its entry as the fold said, so a failed read never hides a row. The words are read at `steps` only: at `everything` a prompt or reply is quiet only when it kept no half at all (see Words) |
| `entries[].outcome` | string or null | `ok`, `failed`, `denied` (a rule or the harness refused it), `parked` (it waits on an approval), or `pending` (nothing came back yet); null for an entry that records no call. At `everything`, a call's request frame cannot say how the call ended, so its entry's outcome is null |
| `entries[].error` | boolean | true when `counts.errors` counts the entry: it failed, it was refused, or a frame in it answers the errors chip. A reader marks the entry's rows failed by this and keeps no rule of its own |
| `entries[].approvalId` | string or null | the approval a parked call waits on (`apr_…`), when its receipt named one |
| `entries[].gates` | object[] | every decision folded into the entry, in the order recorded, each shaped like `decision`. `decision` is the last of them |
| `entries[].subject` | string or null | the tool the entry is about, as the record names it |
| `entries[].tool` | string or null | `subject` as the harness knows the tool, without the prefix a gateway adds (`claude_code__Bash` is `Bash`) or a trailing `@version`; null when `subject` is. A reader names the tool by this and keeps no prefix list of its own |
| `entries[].family` | string or null | the tool's family: `shell`, `read`, `edit`, `create`, `delete`, `search`, `web`, `skill`, `agent`, `plan`, `notebook`, `mcp` or `tool` |
| `entries[].model` | string or null | `provider/model` of a model call |
| `entries[].durationMs` | integer or null | first frame to last; null for one frame, and for a call with no result yet |
| `entries[].echoOf` | string or null | the `key` of an earlier entry in the same turn whose words this reply says again, ignoring surrounding whitespace: on the run's own chain, the operator's prompt (a run recorded before #4051 sealed the transcript's copy of it); on any chain, the model step or reply said last before it, such as a turn's closing message that repeats the model's last text block. What is compared is the digest of each one's trimmed words, not the digest of its body: a model's reply is kept as the stream it arrived in and a closing message as plain words, so the two bodies never share a digest while their words can. Always null at `everything`, where the words are not read. An entry that repeats another is `quiet` |
| `entries[].recall` | object or null | on a recall entry, what it put in front of the model, read from the whole body it kept: `{ unit, count, tokens, cut, items[], bundleVersion, body }`. A steering manifest counts the `items` it included; a context frame counts `frames`. `items[]` lists every item, included and cut, in the order listed, each as `{ kind, label, tokens, outcome, reason, supersededBy, force }`: `outcome` is `included` or `cut` (any recorded outcome but `included` is a cut, and a listing that records none put every item in front of the model), and `reason` and `supersededBy` say why a cut was made where the frame recorded it. `bundleVersion` is the policy bundle a manifest was assembled on. `body` says what the server made of the body: `listed`, `unretained` (none kept), `unreadable` (the read failed or the body no longer hashes to its digest) or `unlisted` (it lists neither items nor frames, or is too large to be a listing). A body not `listed` falls back to the frame count the ledger recorded. No reader parses the body again |

### Words

Two facts need an entry's words, which the fold does not read: whether a prompt or reply has anything to show, and whether a reply repeats words just shown (`echoOf`). At `steps`, every read settles both over the whole run before it counts, so `counts` and the rows a reader draws agree. It reads the half a reader is shown, whole: a prompt's request, a reply's response, and for the model step or reply said right before each reply, its response. A model step's words are the last text block of its reply. Two halves say the same words when the sha256 of their text, trimmed of surrounding whitespace, is equal, and a half whose trimmed text is empty says nothing.

One read settles at most **2 000** halves (`TRANSCRIPT_WORDS_HALF_MAX` in the handler), about three a turn: the first 2 000 in the run's order that kept a body, whether an earlier read already read them or not. An entry past that bound keeps what the fold said about it. So on a run with more word halves than that, the same entries are settled on every page and every live read, and a page's `quiet` marks and `counts` do not change from page to page. A half with no kept body costs no read and does not count against the bound.

A body never changes: its reference names the digest of its bytes. So the server keeps, per process, what `markWords` compares for each body it read for words: whether it shows words, and the digest of those words, never the words. The entries are keyed by the organization, the workspace, the reference and the digest, up to 16 384 bodies (`WORDS_CACHE_LIMITS`). A later page or a live run's tail read reads again no body for words that an earlier read in that process read, except one per key to learn that the key still opens bodies (below). No half is ever answered from this cache: every half on a page, and every half a search looks inside, is read from the evidence store, so a body the store no longer returns, such as one erasure crypto-shredded, shows no text. A read therefore reads the word bodies no earlier read in the process has read, plus at most one body per key, plus whichever of its page's halves those did not already read. Within one read each body is read at most once: a half that was read for its words, for the key, or by a search is answered from that read, up to 32 MiB of bodies a read holds. Only a body read whole settles an entry. A body that could not be read, for any reason, leaves its entry as the fold said: a prompt or reply stays shown, and no reply is marked as repeating it. A body that will fail the same way again is not read again for a minute: the store says it is gone, its bytes no longer hash to its digest, its envelope does not open, or KMS says its key is disabled, pending deletion, or deleted. Erasure is the last case: it destroys the key and leaves the object, so the store answers the object and the decrypt fails. A read that failed any other way, such as a timeout, is tried again on the next read.

A kept digest answers only while its body's key still opens bodies. Erasure destroys a key, so a key KMS refuses fails every body under it, and one that opened a body has not been destroyed. A body whose own envelope does not open (its AES-GCM tag fails, or KMS refuses its wrapped data key as damaged or wrapped by another key) fails only itself. A reference names the deployment's KEK, which seals every body, so one damaged body says nothing about the others. Each read learns this from the word bodies it reads. For a key it reads no body under, it reads one body under that key again. So after erasure a process that read the run before answers the same `quiet` marks and `counts` as a process that never read it, at the cost of at most one body read per key.

`turns` is a group and settles neither fact. `everything` settles neither either: it lists one entry per frame, and the reader that reads it (the Run page's governed actions, Policy and Context tabs) lists decisions, recalls and calls, none of which turns quiet on its words, while `counts.frames` needs no words. At `everything` a prompt or reply is `quiet` only when it kept no half, `echoOf` is null, and `counts` counts a prompt or reply whose words are blank or repeat. At both, the prompts of the `steps` fold still have their words read, one body per prompt, so `figures.prompts` is the same at every zoom; once the run has been read at `steps`, the cache answers them.

## Search

A read with a `query` answers only the entries that hold it (#3942). The chips narrow the entries first, then the query, and the matches page on the same cursor as any other read. The search compares lowercased text, so `Retry` finds `RETRY_LIMIT`.

An entry matches on any of five places, and `matches` lists each one the search looked in that held the query:

- `label` and `target`: the opening frame's label and the target its gate recorded.
- `subject`: the tool the entry is about.
- `request` and `response`: the text of each half, as far as `text: "full"` carries it (16 384 characters). For a half that carries an `assembly`, the text is its blocks: what the model said and thought, each tool it called with its input, and each result's summary.

Label, subject and target are on the entry. The halves are in the evidence store, one read each, and a run can keep a body for every frame. So the search reads no half of an entry that already matched on its label, subject or target, and that entry's `matches` name only those. Of the other entries, one read looks inside at most **2 000** halves (`TRANSCRIPT_SEARCH_HALF_MAX`), in entry order, and still matches the rest on label, subject and target.

A `quiet` entry is not searched: it draws no row, so it can neither match nor count as unsearched, and it spends none of the bound.

A read from a cursor searches only the entries it and the pages after it can still send: those past the cursor, and those before it that grew since they were sent. The pages before it searched the rest, so paging through a search reads each body once rather than once per page.

`search` says what the query found over the entries the read searched: the whole run on a first page, and from the cursor on after it, never only the page:

| Field | Type | Description |
|---|---|---|
| `search.query` | string | the query as searched: trimmed and lowercased |
| `search.matched` | integer | entries that matched, after the chips |
| `search.unsearched` | integer | halves that carried content the search could not look inside: kept as a digest only, not readable or no longer hashing to their digest, or past the 2 000-half bound. A prompt or reply kept as a digest only is no half of its entry, so it is not counted, and neither is a half of an entry that matched on its label, subject or target |

An entry whose only match sits in an unsearched half is not in the answer. A caller that sees `unsearched` above zero says the search was partial.

## Figures

`figures` counts the Run page's figures on the server, over the `steps` fold of every frame read (ADR-182). They were counted in the browser over its own fold until then. The zoom, the chips and the query do not change them, and they share the read's 10 000-frame cap: when `complete` is false they cover a prefix of the run.

| Field | Type | Description |
|---|---|---|
| `figures.steps` | `{ model, tool }` | model steps and tool steps |
| `figures.prompts` | integer | the times the operator prompted the run, the first prompt included, counted as `counts.kinds.prompt` counts them at `steps`: a prompt that is `quiet` there, such as one of only whitespace, is not counted. A subagent's `turn_start` and a model request are not the operator |
| `figures.calls.count`, `.failed` | integer | tool calls, and those whose `outcome` is `failed` or `denied` |
| `figures.calls.tools[]` | `{ name, calls }` | calls per tool, by the tool's name without a gateway's harness prefix (`claude_code__Bash` counts as `Bash`), most called first. `name` is null for calls whose record named no tool |
| `figures.calls.families[]` | object | per family: `family`, `calls`, `share` of all calls, `ms` (the calls' own time), `failed`, and `tools` (distinct names). Most called first |
| `figures.calls.batches` | object or null | the calls between two model steps, which one reply asked for at once. A turn boundary closes a batch too. `count`, `parallel` (batches of more than one call), `widest`, `fanOut` (calls per batch), `serialMs` (every call's own time summed), `togetherMs` (each batch's first start to its last end, summed), and `histogram[]` of `{ width, batches }`. Null for a run that called no tool |
| `figures.wall` | `{ modelMs, toolMs, waitingMs }` | model steps from first frame to last, tool calls' own time, and the time from each `approval_request` to the frame after it |

A call's own time is its entry's `durationMs` less any approval wait that fell inside it, because the wait is the person's and not the tool's. A call with no result adds no time.

The run's wall clock is not in `figures`. It runs from the run's start to its end, or on a live run to the instant the page reads it, and only the reader knows that instant. The part of the clock that `wall` does not account for is the harness's, and the reader takes it against its own clock.

## A model stream is answered as a message, not as a stream

A streaming provider writes a model response down as a few thousand
server-sent events carrying a few characters each. Those bytes are the record
and this capability never changes them. They are also not the message: a
reader given them reads roughly six parts JSON envelope to one part text, and
a cut measured on the envelope lands inside a token.

So a half whose bytes are a recorded model stream carries `assembly` and
`text: null`. The two are alternatives, never both, and the wire bytes are not
on this page at all. `get_run_frame_body` answers them byte for byte when
somebody asks for the transport.

The fold happens once, where the frame is written, and is stored beside the
body. A frame recorded before that, or one whose stored fold this codebase has
since improved, is folded on read instead, and the answer is the same either
way.

| Field | Type | What it is |
| --- | --- | --- |
| `assembly.blocks[]` | object[] | `text`, `thinking`, `tool_use` and `tool_result` blocks in the order the provider indexed them, each with a stable `id`, its `chars`, its apportioned `tokens`, its `cost`, and `partial` when the stream ended before it closed |
| `assembly.precis` | string | the step's one line, built by template from the block kinds; pure, so the same frame gives the same line on every read, and no model wrote it |
| `assembly.stopReason` | string or null | the provider's stop reason, verbatim |
| `assembly.ttftMs`, `.durationMs` | number or null | what the producer timed; the recorded stream carries no clock |
| `assembly.tokensPerSecond` | number or null | output tokens per second of wall time; null without both figures |
| `assembly.usage` | object | `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, each nullable, so no total hides a cache hit |
| `assembly.partial` | boolean | true when the stream ended before the message did; its blocks are still answered |
| `assembly.wire` | object | `events` and `bytes`: what the transport was, for a reader that wants to see it |

A `tool_use` block also carries `stepKey`, the `key` of the tool step that recorded the call, so a reader draws the call once, as that step. The block and the step pair on the call key, or, where either kept none, the block takes the first tool step of the same name, without a gateway's prefix, on the reply's chain and in its turn, after the reply and before that chain's next model call, that no earlier block of the same reply took. A reply's claims depend only on the run and its own blocks, so every zoom and every page claims alike. It is null for a call no tool step recorded. `result` is `{ ok, summary }` from a `tool_result` block on the page that answers the same call key, or null. `family` is the called tool's family, read from its name by the rule that sets an entry's `family`, and `tool` is its name as the harness knows it, by the rule that sets an entry's `tool`.

A `tool_use` block's input carries every string field up to 400 characters and
folds a longer one to `"…N characters"`, with `inputFolded: true`. A `Write`
call's content is the file, and a page of steps carrying every one of them
would be the mistake the wire was. A text or thinking block is cut on a LINE
boundary, never inside a word, and says `truncated: true`.

A block's `cost` is its apportioned share of the message's output tokens at the
model's output rate from the price book. A model the book prices no output for
leaves every block's cost null rather than drawing a zero.

## How much body text a zoom carries

`everything` is one entry per frame and carries up to **16 384** characters per half. `turns` and `steps` fold a whole exchange into one entry and carry up to **1 024** — a page of 200 steps at the full cap is several megabytes of body text nobody asked for on that render, and an excerpt plus the entry's `label` is what a folded level is for. A caller that needs the whole of each body at `steps`, as the Run page does for a tool's output, asks for `text: "full"`, and `text: "excerpt"` cuts `everything` to the smaller cap. A half cut at either cap says `truncated: true`, so a reader follows the frame to `get_run_frame_body` for the whole of it.

## Errors

- `not_found` (404): no run with that id in the caller's workspace.
- `invalid_input` (`invalid_cursor`): a cursor this capability did not write. A stale cursor is refused rather than treated as the start, which would silently restart and repeat the run.

The interface renders the recorded fidelity word and never a stronger one (spec §8.4).
