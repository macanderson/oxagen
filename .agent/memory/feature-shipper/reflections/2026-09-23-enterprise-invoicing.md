## Self-Evaluation — enterprise prepaid invoicing — 2026-09-23
### What I set out to do
Give the maintainer a process to invoice enterprises in advance: record negotiated terms, issue a prepaid order (licence, GAUs, credits) on a professional Stripe invoice, grant on payment, list orders for the customer, name the month and agreement on settlement lines, and set the assistant spend cap an enterprise needs.

### What I actually did (measurable deltas)
- 3 capabilities (`set_contract_terms`, `create_prepaid_invoice`, `list_prepaid_orders`) plus a cap field on `set_org_billing_terms`; 2 operator scripts and a shared lib; runbook `docs/ops/enterprise-invoicing.md`.
- Billing: `prepaid-orders.ts`, `negotiated-terms.ts`, `invoice-copy.ts`, two provider methods, webhook branches, period on settlement lines.
- Fixed `syncInvoiceFromStripe` never refreshing number, due date and paid time after a draft.
- 24 test files green one at a time; two mutation checks on the grant fences went red as expected.

### Quality of my decisions
- Best: carrying the assistant-cap instruction on the Stripe invoice metadata, the one record both the issue-time and the webhook grant read, instead of asking for a schema column mid-task.
- Weakest: naming the capability `issue_prepaid_invoice` because the brief did, then renaming late when `check:naming` refused `issue`. I should have run `check:naming` on the contract name first.

### What I could have done better
- Run `pnpm check:contracts` right after writing the first contract, not at the end. The rename touched eleven files and a sed pass hit two files I do not own (reverted).
- Grep the repo for the arch test's governed identifiers before relying on it. `platform-operator-field.test.ts` was already red on HEAD from a schema comment, and I only found it when adding my own allowlist entry.
- Check `node_modules` link targets before a run that "cannot find" a file I just wrote. Another run relinked the tree into a scratchpad worktree, and I lost time before reading the symlinks.

### What surprised me about this codebase/product
- The invoice mirror upsert updated status and amounts but not the number, so every invoice first mirrored as a draft kept a null number.
- The committed storage manifest lacked the tables the ledger migration added; `schema:manifest:check` would have failed on HEAD.

### Risks I am leaving behind (untouched on purpose, and why)
- `list_invoices` labels a prepaid invoice `subscription`; a new kind touches the app's billing UI and translations.
- The permission catalogue does not list `list_prepaid_orders`; adding it changes which custom roles hold `invoice.read`, an authz change for a human.
- No app UI renders prepaid orders.
- A void after a `grant_on=issue` grant is logged, not reversed; reclaiming credits needs an operator decision.

### Confidence in the result: medium
Unit and contract tests pass file by file, with mutation checks on the fences. Nothing ran against Stripe or a real Postgres, and no typecheck or lint ran locally, so CI is the first compile of this code.
