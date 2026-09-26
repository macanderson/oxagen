# get_run_frame_body

The redacted body of one frame of a run (Mission Control spec §8.2, §8.4 `view`; ADR-058). `get_run` carries every frame's body reference and never its bytes; this capability reads one body on demand, inside the tenant scope, from the organisation's evidence store, and checks the bytes against the recorded digest before answering.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/frame-body`
- MCP: `get_run_frame_body`
- CLI: none
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `get_run_frame_body`
- Not billed (`noBillingGate: true`): reading a recording is a console read (ADR-052 exclusion 2). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |
| `seq` | string | yes | decimal, up to 19 digits: the frame's `run_seq` (ledger) or `seq` (wrapped) as `get_run` reports it |
| `sessionUuid` | string | no | uuid: the subagent chain the frame was recorded on, as `get_run_transcript` names it (`sessionUuid` on a half or an entry's subagent) |

A wrapped run's subagents each record on a chain of their own, numbered from 0 like the run's, so a subagent's `seq` also names a different frame on the run's own chain. Pass the chain's `sessionUuid` with the `seq` to read the subagent's frame. Omit it, or pass the run's own session, to read the run's own chain. The read names the chain and is fenced to the run's root session, so a chain of another run finds nothing.

## Output

| Field | Type | Description |
|---|---|---|
| `contentType` | string or null | the content type recorded with the bytes; null exactly when `bytes` is null |
| `bytes` | string or null | the redacted body, base64; null when the workspace's retention policy kept the digest alone (`fidelity: digest_only`) |
| `digest` | string | `sha256:` over the redacted bytes, recorded at write |
| `redactions` | object[] | `{ path, reason, originalDigest }` per removal made before the body was written |

A caller can recompute `digest` over the decoded bytes: what it read is what was recorded. Under `digest_only` the answer is the digest and no bytes, which is the recorded truth rather than a failure.

## Errors

- `not_found` (404): `run_not_found` (no run with that id in the caller's workspace, whichever store minted it); `frame_not_found` (no frame at `seq` on the chain named; also a `sessionUuid` that is not a subagent chain under this run, and any `sessionUuid` on a ledger run, which has one chain); `frame_has_no_body` (the frame carried no content).
- 500: the stored object does not hash to the recorded digest. The store answered something the record does not vouch for, and the bytes are not returned.

## Storage

Bodies are content-addressed under `evidence/<org>/<workspace>/bodies/<key id>/<sha256 hex>` in the object store, encrypted per object under the platform KEK both the key and the reference name (`evb:v1:<key id>:<hex>`), so a body written after the KEK changes lands beside the earlier one, with the content type framed inside the encrypted plaintext. The tenant is the key prefix, so a reference from another tenant cannot resolve inside this one.
