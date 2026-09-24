# export_billing_statement

**Capability:** `export_billing_statement`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler reads the org the caller's tenant scope names)
**Surfaces:** api, mcp, cli
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; ADR-052 exclusion 2, INV-27)

## Intent

The billing statement `get_billing_statement` builds, as a file (ADR-165). The period rules are the same.

- `csv`: a header block with the statement's summary, a blank line, the column line, then one line per `billing.gau_ledger` row billed in the period. A year can hold millions of rows, so rows come in pages of at most `limit`, read on a keyset over `(billed_at, id)`. The first page carries the header block and the column line. When more rows follow, the answer carries `nextCursor`. Pass it back with the same period for the next page, which carries rows only, so the pages concatenate in order into one file. The header's `Ledger rows in the period` is the number of rows the complete file holds.
- `html`: one self-contained, printable document: inline CSS, the mark drawn inline, no script and no external asset. It carries every section of the statement and its reconciliation notes, and prints to A4 and US Letter. The line items are the CSV's.

A text cell that opens with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe, so no tool or agent name can run as a spreadsheet formula. The HTML escapes every interpolated string and links only `https:` URLs.

The renderers are `packages/billing/src/statement-render.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period`, `anchor`, `from`, `to` | | | as `get_billing_statement` |
| `format` | enum | no | `csv` (default) or `html` |
| `limit` | integer | no | csv: rows per page, 1-50,000, default 10,000 |
| `cursor` | string | no | csv: the `nextCursor` of the page before, for the same period |

## CSV columns

`ledger_entry_id`, `billed_at` (microseconds), `occurred_at`, `source`, `capability`, `tool_name`, `mcp_server`, `surface`, `harness`, `workspace_id`, `workspace`, `agent_id`, `agent`, `operator_user_id`, `operator`, `principal_id`, `principal_kind`, `run_id`, `session_id`, `tool_call_id`, `request_id`, `units`.

## Output

| Field | Type | Description |
|---|---|---|
| `reference` | string | the statement reference |
| `format` | enum | `csv` or `html` |
| `filename` | string | `<reference>.csv` or `<reference>.html` |
| `mediaType` | enum | `text/csv` or `text/html` |
| `content` | string | the page or the document |
| `lines` | integer | csv: ledger rows in this page. html: 0 |
| `nextCursor` | string or null | csv: pass back for the next page; null on the last page and for html |

## Roles

Org Owner, Admin, Billing, as `get_billing_statement` (`assertOrgRole`, INV-29).

## Side effects

None. Read-only; audit-exempt (the kernel's `capability.invoke_*` audit records the access).

## Surfaces

- `POST /v1/{org}/{ws}/billing/statement/export`
- MCP tool `export_billing_statement`
- CLI `oxagen billing statement --period <p> --format csv|html [--out <file>]`, which follows the cursor to the last page
- The app's Billing page, Statements section: Download CSV and Download HTML
- Operators: `pnpm billing:statement` reads the same statement through `@oxagen/billing` directly

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | the acting user holds none of Owner, Admin, Billing in the org |
| `invalid_input` | the period breaks a rule (as `get_billing_statement`), `invalid_cursor` (a cursor this export did not write for this period), or `cursor_not_paged` (a cursor with `html`) |
