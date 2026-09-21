# create_run_token

**Surfaces:** api

`POST /v1/:org_slug/:workspace_slug/runs/token` issues a credential for an
existing ledger run and attempt. It creates no run, attempt, or process.
An organization Owner or Admin, or workspace Owner or Member, may issue it.
Machine credentials cannot issue another credential.

The strict input contains `runId` (`arun_...`) and `attemptId` (`arat_...`).
The output contains `token`, shown once, and `expiresAt`. The credential is
stored as a SHA-256 hash in `auth.api_keys`. Its server-authored scope binds
the organization, workspace, run, and attempt. Its purpose permits only
`ingest_run_frames`. Generic key creation and rotation refuse this purpose.

Issuance locks the run and refuses cancelled or ended runs, sealed attempts,
and attempts outside the named run or workspace. Expiry is fifteen minutes.
Successful ingress refreshes the same credential's expiry, so losing an
HTTP response does not lose the only valid credential. An expired credential
requires a fresh authorized issuance. Cancellation refuses that issuance.

Dedicated Postgres planes remain unsupported for credential issuance. The
authentication resolver reads credentials from the shared plane, so issuance
refuses before minting a secret on a dedicated plane. Adding authenticated
plane discovery remains part of #2953. The run read exposes `ingressRevoked`
separately from process status. Repeat cancellation returns the existing
applied receipt, and the Run page disables the cancelled ingress control.
