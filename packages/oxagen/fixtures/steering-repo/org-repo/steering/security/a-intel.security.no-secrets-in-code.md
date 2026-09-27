---
schema: steering-record/v1
lineage: a-intel.security.no-secrets-in-code
label: No secrets in code
description: Credentials live in the vault, never in a repository.
kind: constraint
effect: forbid
force: must
scope: organization
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5Z0SC
id: rec_a_intel_security_no_secrets_in_code_a0e796007f46
hash: sha256:152fa9b6c95b1fd710830fbecce8a8576ee30b8adf93d9b162f8d1f1c54fd274
---

Do not write a key, a token, or a password into a file or a commit. Read it
from the environment the run provides, and ask a person when it is missing.
