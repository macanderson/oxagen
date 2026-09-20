// The ceiling `dispatch_command` puts on a command's reason, mirrored for the
// client.
//
// The contract is the source of truth, but a `"use client"` file may not
// import it. `tacho.command.dispatch` reaches `run.list`, which imports
// `@oxagen/run-evidence`, and that reaches a Node builtin; Turbopack refuses a
// browser chunk that asks for `node:readline` and fails the build of the page
// that pulled it in. `@/data/contracts/run` mirrors the transcript page size
// for the same reason. The UI kit may not take a value from
// `@/data/contracts/*` either (ARCHITECTURE.md §2), so the mirror sits here,
// where the row's dialog and the refusal sentence can both read it.
//
// `command-reason.test.ts` reads the contract under Node and is what keeps the
// mirror honest: a change to the contract's ceiling fails there, not in a
// reason a person silently cannot finish typing.
export const COMMAND_REASON_MAX = 512;
