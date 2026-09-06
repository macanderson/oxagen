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

The platform in `916294258235` wraps ingestion connector credentials with a key
in **this** account. `packages/crypto/src/ingestion.ts` names that ARN as
required when the provider is `kms`, so it is the key in use rather than a
leftover setting.

That makes this account load-bearing, not merely undecommissioned. Deleting the
key stops new encryption, which is an outage; it also makes every credential
already wrapped with it permanently undecryptable, which no rotation recovers.
Settle #2680 before anything here is deleted.

Both parameters are SecureString. Read without `--with-decryption` they return
ciphertext, which reads like a non-answer — that is how this went unestablished
for as long as it did.

Deleting the Terraform would not delete the keys. It would delete the only
record of how they were made.

## What nobody has established

Which account the running platform uses is settled above: this one, for
ingestion. What is still open:

- Whether the new account has equivalent keys to move to, and what the re-wrap
  path is for ciphertext already written under the old key.
- The second alias. `alias/oxagen/auth-tokens-prod` and
  `AUTH_TOKEN_ENCRYPTION_KEY` have not been checked the same way. Assume
  nothing from the ingestion answer; run the same two `get-parameter` calls.

The cutover checklist is marked complete, and this stack was last touched in
June by a commit about something else — those two facts together are why the
rest of this needs a person rather than a guess.

Nothing here is applied by CI. `infra/stacks-new/` is the live account and is
applied by `.github/workflows/infra.yml`; this directory is deliberately
outside that workflow's path filters.
