# ADR-167: A record picker reads its options through the port

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** app
- **Related:** ADR-089 (an on-demand read lives in a `"use server"` module),
  ADR-110 (a merge can drop a branch's change), #4040, #4045, #3983,
  `apps/app/ARCHITECTURE.md` §2 (the layer matrix) and "Shell activity
  boundaries", `apps/app/src/test/arch/layers.ts` (`PORT_READING_ACTIONS`),
  `apps/app/src/test/arch/probes/import-graph/data-source-use-server.ts`

## Context

#4040 replaced every form field that took a typed record id with a record
picker (`apps/app/src/ui/record-picker.tsx`). You type part of a name and pick
the record. The form still submits the id or pattern the old field sent.

A picker loads its options the first time you open it, inside a form.
Reading every list when the page renders would read the tool registry, the
members, the runs, and the price book for forms a visit may never open.
ADR-089 covers a read like this. An on-demand read lives in a
`"use server"` module that resolves its own viewer.

ADR-089's read calls `kernelRead` against a contract. The picker's eight lists
already have a port method each: `tools.versions`, `tools.mcpServers`,
`tools.connections`, `agents.list`, `runs.list`, `org.members`,
`spend.priceBook`, and `spend.unpricedModels`. Each one calls the kernel, maps
the contract's output to the app's view model, checks the result against that
view model's zod schema, and reports a record it cannot map. Two of the
mappings rename ids. `toMcpServerList` answers `publicId` as `id`, and
`toConnectionList` answers `publicId` as `id` and `connectorId` as
`connector`, so the picker writes the public id the form always sent. The view
models in `data/contracts` type every `id` as a `PublicId` (INV-11), and the
port's schema check is what holds a live answer to that.

Before #3983 the layer rule named one `"use server"` feature module that could
read a port directly, `features/shell/activity-actions.ts`, for the shell's
drawers. This branch added `features/shell/choice-actions.ts` beside it. #3983
deleted `activity-actions.ts` and removed the grant with it. Merging `main`
into this branch took #3983's side and dropped `choice-actions` from the list,
the kind of loss ADR-110 describes. `import-graph.test.ts` then refused
`choice-actions.ts:12 @/data/source`.

## Decision

**`features/shell/choice-actions.ts` may import `dataSource` from
`@/data/source`, and only while it carries `"use server"`.** No other feature
module may.

- `layers.ts` names the module in `PORT_READING_ACTIONS`. The `features` row
  admits `data/source` only for a module on that list with the directive.
- Every exported action resolves its viewer with `requireViewer` before it
  reads, and returns `Promise<ActionResult<OptionPage>>`. `actions.test.ts`
  (INV-19) holds both.
- The probe `data-source-use-server.ts` passes at `choice-actions.ts` and fails
  at `account-actions.ts` and `tools/actions.ts`. The directive-less probe
  `imports-data-source.ts` fails at `choice-actions.ts`.
- A second module joins the list only with its own reason, written in
  `layers.ts` and added to this record.

## Alternatives rejected

**Call `kernelRead` in `choice-actions.ts`, as ADR-089 does.** The module
would map eight contract outputs itself. That is a second copy of each
mapper in a feature lane, carrying the id renames, without the view-model
check that holds them to INV-11. When a contract's output changes,
the port and the picker would have to change together, and nothing would
fail if only one did.

**Admit `data/source` from any `"use server"` feature module.** That opens the
whole `DataSource` to every action in the app to serve one module. The kernel
seam is the default for an on-demand read, and a named list keeps each
exception visible.

**Resolve the options in the page and pass them down.** The page would read
the registry, the members, the runs, and the price book on every render, for
forms most visits never open. ADR-089 rejected the same trade for the
Workspace settings dialog.

## Consequences

- A picker's list and the page that shows the same records read one mapping.
  A mapper fix reaches both.
- `ARCHITECTURE.md` §2 names the grant in the `features` row, and "Shell
  activity boundaries" says where a picker's reads live.
- The rule is a named list. A reviewer who sees an entry without a matching
  section in this record has found a defect.

## Second module: the assistant's parked approvals (2026-09-25, #4162)

`features/shell/assistant-approval-actions.ts` joins the list, under the same
terms: `"use server"`, `requireViewer` before the read, and an
`ActionResult` answer.

The assistant flyout draws each write a turn parked as a card with Approve and
Deny. A card shows what its approval row records, because a person on Fleet, a
second viewer, the expiry sweep and the decision's own delivery (ADR-118) all
change that row, and the flyout and Fleet have to agree. So the card reads the
row after every decision and while it still waits. The rows arrive with the
turn, long after the layout rendered, so no route render can hand them down.

The approvals port's `pending` and `resolved`, narrowed to the turn's run, are
the reads the Run page's Governed actions tab makes for the same rows. Reading
them through `kernelRead` instead would copy both mappers into the shell lane,
with the public-id mapping and the view-model check, which is the trade this
record rejects for the picker.

- `layers.ts` names the module in `PORT_READING_ACTIONS` with this reason.
- `import-graph.test.ts` places the `data-source-use-server.ts` probe at the
  module, where it passes, and the directive-less `imports-data-source.ts`
  probe there, where it fails.
