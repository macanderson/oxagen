// INV-02, the compile-time half (ARCHITECTURE.md §3.1). Compiled by the app's
// `tsc --noEmit`, never executed: each directive below must meet an error, or
// TS2578 fails the typecheck. `Object.assign({}, real, { orgId })` has no case:
// no directive can hold on it, and `OrgCtx.is` refuses it at runtime
// (viewer.test.ts).
import { OrgCtx, type PretenantCtx, type WsCtx } from "./viewer";

declare const token: Parameters<typeof OrgCtx.mint>[0];
declare const org: OrgCtx;
declare const ws: WsCtx;
declare const pretenant: PretenantCtx;
const fields = {
  userId: "u",
  orgId: "o",
  orgSlug: "acme",
  orgName: "Acme",
  orgRole: "owner",
} as const;

// @ts-expect-error -- an object literal with every field lacks the private brand
const _literal: OrgCtx = { ...fields };

// @ts-expect-error -- a spread copy of a real context lacks the private brand
const _spread: OrgCtx = { ...org, orgId: "victim" }; // eslint-disable-line @typescript-eslint/no-misused-spread -- the spread copy is the case

// @ts-expect-error -- a pre-tenant context is not an organization context
const _crossClass: OrgCtx = pretenant;

// @ts-expect-error -- an organization context is not a workspace context
const _narrowed: WsCtx = org;

// @ts-expect-error -- the constructor is protected: only the class mints
new OrgCtx(token, fields);

const _forged = class Forged extends OrgCtx {
  constructor() {
    // @ts-expect-error -- a subclass cannot pass the constructor a token it does not hold
    super(Symbol("mint"), fields);
  }
};

// The one positive: a workspace context is an organization context.
const _widened: OrgCtx = ws;
