"use client";

// The shell's public client entry. A client component in another lane imports
// from here, never from the server barrel: `@/features/shell` re-exports the
// landing redirect and the export route, which reach the database, and a
// client import of the barrel puts those modules in the browser bundle.
export { openApprovals } from "./shell-actions";
