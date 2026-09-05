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
still encrypts against these keys is a question about deployed configuration,
not something the code answers.

Deleting the Terraform would not delete the keys. It would delete the only
record of how they were made.

## What nobody has established

Whether the new account has equivalent keys, and which account the running
platform actually uses. The cutover checklist is marked complete, and this
stack was last touched in June by a commit about something else — those two
facts together are why this needs a person rather than a guess.

Nothing here is applied by CI. `infra/stacks-new/` is the live account and is
applied by `.github/workflows/infra.yml`; this directory is deliberately
outside that workflow's path filters.
