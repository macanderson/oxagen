# Ingestion key cutover — off the retired AWS account

**Status: the code and the infrastructure have landed. One verification
remains, and it needs credentials for `916294258235`.**

This is the record of how production stopped depending on a KMS key in the
retired account, what proves it, and the one thing nobody has run yet. It
exists because the dependency was invisible for two weeks and the way it
stayed invisible is worth not repeating.

## What was wrong

The platform wraps every stored connector credential and OAuth token with the
KMS key named by `/oxagen/production/AWS_KMS_INGESTION_KEY_ARN`
(`packages/crypto/src/ingestion.ts`). After the 2026-08-27 cutover that
parameter still named a key in `578673726240`, in `us-east-2` — the account
everything else had moved away from.

Two separate problems sat behind that one line.

**It was a cross-account dependency nothing recorded.** Retiring the old
account would have taken the platform's encryption with it. Deleting the key
is worse than an outage: anything already wrapped with it stops being
decryptable, and no rotation recovers that.

**It had never worked from the new account.** The old key's policy admits only
`578673726240:root`, and the node role in `916294258235` was granted nothing
on it. Every encrypt call since the cutover failed with
`kms:GenerateDataKey ... not authorized`, so the GitHub connect flow returned
500 at its OAuth callback every time it was tried — 2026-08-31, and twice on
2026-09-09.

The second fact is what made the first tractable. Every ciphertext column in
production was empty on 2026-09-09, including `token_kms_key_id` on both
`auth.accounts` rows, because nothing here had ever been able to encrypt.
**There is no old-key ciphertext, so there is nothing to re-wrap.** The
re-wrap path the issue planned for is not needed.

## How it stayed invisible

Reading `/oxagen/production/*` with a contributor's credentials reads the
store in `578673726240`. The deploy node lives in `916294258235` and reads its
own. **Two different objects with the same path**, and a read from a laptop
describes the pre-cutover deployment while looking exactly like a read of the
running one.

Both parameters are `SecureString`. Read without `--with-decryption` they
return base64 KMS ciphertext, which reads like a non-answer rather than a
secret, so the natural next step is to stop rather than to add the flag.

Any command that reads these should print the identity in the same
invocation, so the account is shown rather than assumed. That is what
`infra/tools/verify-ingestion-key.sh` does.

## What landed

`infra/stacks-new/oxagen/crypto.tf` creates the key in the account that uses
it, grants the node role exactly the calls envelope encryption makes, and
manages the parameter so its ARN can never again name a key this stack does
not own. The parameter is `import`ed rather than recreated — it has existed
since the cutover and creating it again fails on `ParameterAlreadyExists`.

The node module already grants `kms:Decrypt` under a `kms:ViaService`
condition on SSM, for reading its own parameters. That condition excludes the
direct call the crypto adapter makes, which is why a second key-scoped
statement lives in `crypto.tf` rather than being folded into the module.

**Applied to production on 2026-09-09**, by
[run 34411814281](https://github.com/macanderson/oxagen/actions/runs/34411814281)
on `main`:

```
aws_kms_key.ingestion: Creation complete after 10s [id=c332275c-…]
aws_kms_alias.ingestion: Creation complete [id=alias/oxagen-app/ingestion]
aws_iam_role_policy.node_kms_ingestion: Creation complete [id=oxagen-app-node:oxagen-app-use-ingestion-key]
aws_ssm_parameter.ingestion_kms_key_arn: Modifications complete
Apply complete! Resources: 1 imported, 3 added, 1 changed, 0 destroyed.
ingestion_kms_key_arn = "arn:aws:kms:us-east-1:916294258235:key/c332275c-…"
```

## The trap in calling that done

**Changing the parameter does not change a running service.**
`infra/tools/node/deploy-service.sh` reads Parameter Store once, at deploy
time, and materialises every value into the container's environment. A process
already running keeps the ARN it was started with until it is redeployed.

So the parameter naming the right key and the platform using the right key are
two different facts, and a check that reads only the parameter would report
the cutover complete while every live service still called the retired
account's key.

All five services were redeployed after the apply — `app`, `api`, `mcp`,
`docs` and the marketing site, between 08:05 and 08:34 UTC on 2026-09-10, in
[run 34449061380](https://github.com/macanderson/oxagen/actions/runs/34449061380).
The key landed at 22:22 UTC the previous day, so the running containers should
now hold the new ARN. **Should** is the gap the verification below closes.

## The one thing still to run

Needs credentials for `916294258235`, which no contributor machine currently
has (`sts:AssumeRole` is denied, and the CI deploy role holds no
`ssm:DescribeParameters`).

```bash
infra/tools/verify-ingestion-key.sh api
```

Read-only. It runs on the app node over SSM and reads three things: the ARN in
Parameter Store, the ARN inside the running container, and an encrypt/decrypt
round trip under the second. `kms:Encrypt` and `kms:Decrypt` are data-plane
calls — no key, parameter or container is modified.

A pass looks like this, and is what should be pasted onto issue #2680:

```
=== identity for THIS read ===
916294258235    arn:aws:sts::916294258235:assumed-role/oxagen-app-node/…
INGESTION_CRYPTO_PROVIDER = kms
AWS_KMS_INGESTION_KEY_ARN = arn:aws:kms:us-east-1:916294258235:key/c332275c-…
container AWS_KMS_INGESTION_KEY_ARN = arn:aws:kms:us-east-1:916294258235:key/c332275c-…
round trip OK
PASS: api encrypts with arn:aws:kms:us-east-1:916294258235:key/c332275c…
```

Three failures are distinguished, because they need three different actions:

| What it says | What it means | What to do |
|---|---|---|
| running key is in `578673726240`, parameter is in `916294258235` | the Terraform landed, this service has not been redeployed since | redeploy the service |
| both ARNs are in `578673726240` | the apply has not reached this account | apply `stacks-new/oxagen` |
| both in `916294258235` but different keys | the service is a deploy behind, nothing reaches the old account | redeploy when convenient |

Run it for each service that encrypts. `api` is the one that matters — it
serves the OAuth callback — and `app` and `mcp` share the adapter.

The behaviour above is held by `infra/tools/tests/verify-ingestion-key.test.sh`,
which runs in CI through `check:db-migrate-script`.

## The old key, afterwards

**Do not delete it as part of this.** Retiring it is a separate act with its
own confirmation, and it should follow a passing verification rather than
accompany it.

Once the verification passes, nothing in `916294258235` depends on
`alias/oxagen/ingestion-prod`. There is no ciphertext under it, so deleting it
destroys nothing — but that claim rests on the 2026-09-09 reading of the
ciphertext columns, and it is cheap to re-read before acting.

`alias/oxagen/auth-tokens-prod` is a separate question with a simpler answer:
**nothing can use it.** `AWS_KMS_AUTH*` appears nowhere in `packages/` or
`apps/`, and `AUTH_TOKEN_ENCRYPTION_KEY` is a base64 256-bit key the code uses
directly with no KMS call in the path. That is a fact about the code, so it
holds whatever any parameter store contains.

`infra/legacy/` keeps the Terraform that made both keys. Deleting it would not
delete the keys; it would delete the only record of how they were made.

## Related

- Issue #2680 — the cross-account dependency.
- Issue #2696 — the epic making the new account safe for its first apply.
- `infra/legacy/README.md` — the old account's stack and the two-stores trap.
- `infra/stacks-new/oxagen/crypto.tf` — the key, the grant, the parameter.
