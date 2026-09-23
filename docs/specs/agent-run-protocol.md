# Agent Run Protocol: local checkpoints

Use a signed checkpoint to carry selected files, task context, and a reference to a recorded turn into another harness. Agent Run Protocol (ARP) builds on Context Graph Protocol (CGP) for context frames and Oxagen's existing record formats for source evidence. The local ARP slice captures a stopped workspace and prepares a fresh workspace for Claude Code, Codex, Cursor, or Stella. You choose the destination harness explicitly.

ARP does not launch an agent. You review the prepared files and start the destination harness yourself. The decision follows [ADR-157](../adr/ADR-157-local-arp-checkpoints-prepare-external-runs.md) and the [runtime boundary](../adr/ADR-043-runtime-excision.md).

## Build on CGP

CGP already defines `ContextFrame`, `FrameId`, provenance, token costs, fidelity, and the `full`, `compact`, and `reference` representations. ARP reuses those concepts. It introduces neither a replacement context frame nor another journal schema. See [CGP's frame representation decision](https://github.com/macanderson/context-graph-protocol/blob/main/docs/adr/0005-frame-representations.md).

The local handoff carries the operator summary as a CGP `episode` frame in the `full` representation. Its content is the complete supplied summary. This does not mean the summary reproduces the complete source conversation. The compatibility report records that loss separately. A future adapter carrying compact or referenced context must follow CGP's existing fidelity and resolution rules.

CGP content identity and a source record boundary answer different questions. A `FrameId` identifies context content. ARP's source locator identifies a position in a particular evidence stream by format, issuer, stream identifier, sequence, and digest. The checkpoint binds that exact boundary to the restorable file selection.

The existing [`contextgraph-trace`](https://github.com/macanderson/context-graph-protocol/blob/main/contextgraph-trace/README.md) vocabulary covers prompt assemblies, tool pairing, side effects, crashes, and resumes. Tacho already ports its [types](../../packages/tacho/src/trace/types.ts), [projection](../../packages/tacho/src/trace/project.ts), and [replay checks](../../packages/tacho/src/trace/oracles.ts). ARP evidence checks reuse that projection and those checks. A skipped check means the source supplied insufficient evidence for that check, not that the property held.

`contextgraph-trace` remains a sketch outside core `contextgraph/1.0`. Consumers must pin and check the explicit journal format, currently `contextgraph-trace/0.1-sketch`, through Tacho's `TRACE_FORMAT`. A crate or package version does not establish journal compatibility. The signed source evidence retains its own `tacho/1.0` format.

ARP adds the transfer contract around these existing pieces: restorable snapshots, an exact source boundary, target admission and launch preparation, and experiment lineage. This local slice implements capture, verification, and preparation. Destination policy admission, managed handoff, and experiment management remain separate work.

## Capture a stopped turn

Stop the source harness after a completed turn. Export its Tacho record while the last frame is `turn_end`:

```sh
tacho export --session SOURCE_RUN_ID --format tacho --out /tmp/source.ndjson
```

Keep the workspace stopped through capture. ARP checks the exported chain and its last frame. It cannot establish that another process has stopped or reconstruct the files that existed at an earlier frame. `--attest-boundary` records your assertion that the stopped workspace matches the specified frame. The snapshot is client-attested.

Create a brief that names every file to export:

```json
{
  "schema": "arp.capture-brief/0.1",
  "task": "Finish the parser change and check the error cases.",
  "context": "The parser now accepts empty input. The malformed-header case still needs review.",
  "files": ["package.json", "src/parser.ts", "src/parser.test.ts"],
  "exclusions": [
    {
      "path": "node_modules",
      "reason": "Install dependencies in the destination workspace.",
      "required": false
    }
  ],
  "export_authorized": true,
  "boundary_digest": "sha256:REPLACE_WITH_LAST_FRAME_DIGEST"
}
```

All fields are required. Use the last exported frame's `hash` value for `boundary_digest`. `files` accepts explicit relative paths to regular files. It does not accept directories or symlinks. Include the source, dependency manifests, instructions, and other files the task requires. An exclusion records an omitted path and your reason. It does not supply its contents.

`context` is your handoff summary, carried in a CGP frame. It is not a native conversation export. `export_authorized: true` records your approval to export this selection. It is not a signed organization policy and cannot override an active organization rule. Confirm that your organization permits the export before capture.

Use an existing Ed25519 private key in PEM format:

```sh
tacho arp capture \
  --workspace /path/to/stopped-workspace \
  --evidence /tmp/source.ndjson \
  --brief /path/to/brief.json \
  --out /path/to/new-checkpoint \
  --key /path/to/checkpoint-private.pem \
  --attest-boundary
```

Capture prints JSON containing `checkpointDigest` and `publicKey`. The public key uses `ed25519:<base64>`. Keep the private key outside the selected files. Capture rejects credentials recognized by the existing content detector. That detector does not prove that every selected file, including binary content, is free of secrets. Review the selection before exporting it.

## Verify and prepare

Obtain the signer's public key through a channel you trust. Pin it independently of the checkpoint you received. A key printed by capture identifies the signer but does not establish that you trust that signer.

```sh
tacho arp verify \
  --bundle /path/to/checkpoint \
  --public-key 'ed25519:PINNED_BASE64_KEY'

tacho arp prepare \
  --bundle /path/to/checkpoint \
  --destination /path/to/new-preparation \
  --public-key 'ed25519:PINNED_BASE64_KEY' \
  --harness claude-code
```

Choose `claude-code`, `codex`, `cursor`, or `stella` for `--harness`. There is no default. Preparation verifies the signature, checkpoint references, and selected file contents before preparing a separate workspace. It returns JSON with the checkpoint digest, workspace path, prompt file, compatibility report path, and a command expressed as a binary plus an argument array.

Read the compatibility report and the prompt file before starting the destination. The report marks this transfer as degraded because the destination gets an explicit summary and selected files rather than the source harness's internal state. The prompt treats carried context as untrusted data. Imported approvals do not authorize destination actions.

Start the returned command from the returned workspace only when you are ready to continue. Treat its argument array as arguments, not as a shell expression. The adapters use these ordinary prompt forms:

| Harness | Command shape |
|---|---|
| Claude Code | `claude PROMPT` |
| Codex | `codex PROMPT` |
| Cursor | `agent PROMPT` |
| Stella | `stella run PROMPT` |

The generated prompt points to the prepared prompt file. ARP does not set permission-bypass flags, change global configuration, provision credentials, or launch these commands. The destination harness applies its current permissions and organization rules. The next run has its own history.

## What this slice establishes

The checkpoint binds a selected workspace snapshot and operator brief to a Tacho chain boundary. It preserves the source evidence rather than rewriting it into destination history. Verification establishes the integrity of the supplied checkpoint under the pinned key. It does not establish the truth of the operator's summary, the workspace's historical state, or organization authorization.

Preparation restores only the files named in the brief. It does not reproduce model internals, native tool state, running processes, environment variables, dependency installations, or external systems. Recorded external actions remain evidence. ARP does not repeat them during preparation.

You can prepare several separate workspaces from one checkpoint to compare candidate runs across harnesses. You remain responsible for starting those runs and keeping their external effects separate. This slice does not provide enforced source fencing, candidate scheduling, shared budgets, result ranking, or winner promotion.

The broader ARP design builds on CGP rather than duplicating its frame, representation, or fidelity contracts. ARP adds immutable checkpoint parents, separate child histories, transfer compatibility, and destination-local authority. Historical-frame reconstruction, enforced checkpoint barriers, managed handoff, and a cross-harness best-of-N evaluator require further implementation. The local slice does not claim production interoperability or a lossless native-history migration.
