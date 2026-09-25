"use client";

// The Fleet lane's public client entry. A client component in another lane
// imports from here, never from the server barrel: `@/features/fleet` reaches
// server-only modules, and a client import of it puts them in the browser
// bundle (INV-21).
//
// The assistant flyout's parked cards decide through this action, the one
// Fleet's approval dialog uses, so a call parked in a turn is resolved by the
// person who is signed in, through one path to `resolve_approval`.
export { resolveApprovalAction } from "./actions";
