# Legacy — the old account's KMS stack

This is the Terraform that lived at `infra/` in the platform repo before the
live infrastructure moved in beside it. It is kept because it manages real
keys, not because anything applies it.

## What it is

A bootstrap stack, one production environment, and a KMS module that creates
two aliases:

- `alias/oxagen/ingestion-prod`
- `alias/oxagen/auth-tokens-prod`

Its backend is `oxagen-tfstate-578673726240`, key `production/terraform.tfstate`,
region `us-east-2`. That is the **old** account, the one the 2026-08-27 cutover
moved away from and which has not been decommissioned.

## Why it is here rather than deleted

Both aliases exist in that account today, and the platform's vault
(`packages/plugins/src/vault/vault-secret-service.ts`) takes a KMS key id from
configuration rather than a hardcoded ARN. So whether the running platform
still encrypts against these keys was a question about deployed configuration,
not something the code answers.

**It has been asked, and the answer is yes.** On 2026-09-06 the deployed
configuration read:

```
/oxagen/production/INGESTION_CRYPTO_PROVIDER  = kms
/oxagen/production/AWS_KMS_INGESTION_KEY_ARN  = arn:aws:kms:us-east-2:578673726240:key/…
```

That reading was the configured key, not a working one. The key's policy
admits only `578673726240:root`, and the node role in `916294258235` was never
granted anything on it, so every encrypt call from the new account failed with
`kms:GenerateDataKey ... not authorized`. The GitHub connect flow returned 500
at its OAuth callback every time it was tried after the cutover (2026-08-31,
and twice on 2026-09-09). On 2026-09-09 every ciphertext column in production
was empty, so nothing is wrapped with this key.

**Since #2680 the platform encrypts with its own key**,
`alias/oxagen-app/ingestion` in `916294258235`, created in
`infra/stacks-new/oxagen/crypto.tf` beside the grant for the node role and
the parameter that names it. Nothing in the new account depends on the key
here. Deleting it is still a maintainer's call, and this directory still
records how it was made.

Both parameters are SecureString. Read without `--with-decryption` they return
ciphertext, which reads like a non-answer — that is how this went unestablished
for as long as it did.

Deleting the Terraform would not delete the keys. It would delete the only
record of how they were made.

## What nobody has established

Which account the running platform uses is settled above, from the new
account's own store: the old one, for ingestion. What is still open:

- Whether the new account has equivalent keys to move to, and what the re-wrap
  path is for ciphertext already written under the old key.

## The second alias: nothing can use it, whatever the parameters say

`alias/oxagen/auth-tokens-prod` is referenced by this file and by the Terraform
below that creates it, and by nothing else. `AWS_KMS_AUTH*` appears nowhere in
`packages/` or `apps/`, and the registry describes `AUTH_TOKEN_ENCRYPTION_KEY`
as a base64 256-bit KEK generated with `openssl rand -base64 32` — a local
symmetric key the code uses directly, with no KMS call in the path.

That is a fact about the code, so it holds regardless of what any parameter
store contains: even if a `AWS_KMS_AUTH_TOKENS_KEY_ARN` existed somewhere, no
shipping code would read it.

The parameter store agrees, checked in the new account rather than assumed:
`/oxagen/production/AUTH_TOKEN_ENCRYPTION_KEY` there is 43 characters of key
material, not an ARN — base64 of 32 bytes, as the registry describes.
`/oxagen/production/INGESTION_ENCRYPTION_KEY` is the same shape, and is the
`local` provider's key, unused while the provider is `kms`. So the
cross-account dependency is exactly one key, and
`alias/oxagen/auth-tokens-prod` is not it.

**What is NOT established, and the distinction matters.** Reading
`/oxagen/production/*` with a contributor's credentials reads the store in
`578673726240` — this account. The deploy node lives in `916294258235` and
reads its OWN store, so those two prefixes are different objects with the same
name. A read from here describes the pre-cutover deployment, not the running
one, and cannot tell a live setting from a leftover.

**That read has now been done.** On 2026-09-08, against
`916294258235`/`us-east-1` — identity and parameter fetched in one command so
the account cannot be assumed:

```
identity: 916294258235 / us-east-1
/oxagen/production/INGESTION_CRYPTO_PROVIDER = kms
/oxagen/production/AWS_KMS_INGESTION_KEY_ARN = arn:aws:kms:us-east-2:578673726240:key/...
```

Version 1, written 2026-08-26 and never changed. So this is the running
platform's own configuration, not a pre-cutover reading taken from the wrong
store. The new account points at the old account's key.

The key itself is alive: `describe-key` in `us-east-2` returns `Enabled`,
`CUSTOMER`-managed, `ENCRYPT_DECRYPT`, with no deletion scheduled. Ingestion
did **not** work from the new account: the key policy names only the old
account's root, so the reading above was a configured key the platform could
never call. `crypto.tf` in the live stack replaced it.

The cutover checklist is marked complete, and this stack was last touched in
June by a commit about something else — those two facts together are why the
rest of this needs a person rather than a guess.

Nothing here is applied by CI. `infra/stacks-new/` is the live account and is
applied by `.github/workflows/infra.yml`; this directory is deliberately
outside that workflow's path filters.
