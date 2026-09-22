# Export and verify a run

You need to hand a sealed run to someone outside your organisation, such as an auditor, and they need to check it without trusting Oxagen or calling it. Oxagen writes the run into a signed bundle. The auditor checks that bundle on their own machine with the `oxagen` CLI, offline.

An org Owner or Admin exports. The auditor needs no Oxagen account.

## Steps

### Operator

1. Open the run in the app (`/{org}/{ws}/runs/{run}`) and choose **Export**. The run must be sealed. From a terminal, run `oxagen run export <run-id>` instead. Either way you get an export id, `rexp_…`.

2. Wait for the bundle. The Run page shows the status and turns it into a download link when it is `ready`. From a terminal, run `oxagen run export-status <export-id>`. A `failed` export shows the job's error.

3. Download the bundle. Choose the link on the Run page, or run `oxagen run download <export-id>`. The CLI writes `<run-id>-<export-id>.zip` and checks its sha256 against the digest the export recorded.

4. Hand the auditor the zip. You can also send them the link from step 2 instead. It works without a login for 15 minutes, and reading the status again mints a new one.

### Auditor

5. Install the CLI on your machine: `curl -fsSL https://cli.oxagen.sh/install.sh | sh`, or `npm install -g @oxagen/cli` with Node.js 20 or newer. No sign-in is needed for the next steps.

6. If you received a link, download it: `curl -fLo bundle.zip '<link>'`. The response header `X-Bundle-Digest` is the sha256 of the zip.

7. Disconnect from the network if you want to prove the check makes no call, then run `oxagen verify bundle.zip`. It reads the zip, or a directory you extracted it into, and nothing else.

8. Read the frame lines. Each frame prints `held` or `broken`, with two checks:
   - `digest`: for a ledger run (`arun_…`), the payload hashes to `payload_digest` and the frame's identity fields hash to `event_digest`, both under RFC 8785. A wrapped session (`tse_…`) prints `not carried`, because the export holds a projection of each event, and its hash was taken over the full event.
   - `link`: the frame's place in its chain. For a ledger run, `attempt_seq` counts up from 1. For a wrapped session, `prev_hash` is the previous frame's `hash`.

9. Read the bundle checks. The frame count, the Merkle root over every frame digest, each attempt's root against its signed attestation, each Ed25519 signature and key id, and each ledger attempt's `event_stream_digest` fold must all print `held`. Compare the printed key id with the one the operator gives you through a separate channel.

10. Read the redaction summary. It lists what the host removed before the bytes were written, by kind and count (for example `github_token 2`), and what the bundle does not carry (`frame_body`, `encrypted_payload`). It never shows a value. `oxagen verify` recomputes the summary from the frames, so an edited summary prints `broken`.

The last line is `HELD <run-id>` when everything holds, and the command exits 0. Anything broken prints `BROKEN`, names the frame or check, and exits 1. `oxagen verify --json` prints the same result as JSON.

## Without the CLI

The zip also holds `verify.mjs`, which runs the same checks with Node.js alone: unzip the bundle, then run `node verify.mjs <directory>`.

## Reference

- [`export_run`](../capabilities/run.export.md) and [`get_run_export`](../capabilities/run.export.get.md)
- The verifier: `packages/tacho/src/evidence/run-export.ts`
