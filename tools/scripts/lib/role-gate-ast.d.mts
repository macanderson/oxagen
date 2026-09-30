/**
 * Type declarations for role-gate-ast.mjs, kept as plain .mjs so CI runs
 * check-role-enforcement.mjs with bare `node`.
 */
import type ts from "typescript";

export declare function parseSource(
  fileName: string,
  text: string,
): ts.SourceFile;
export declare function dottedName(node: ts.Node): string | null;
export declare function isCallTo(
  node: ts.Node,
  name: string,
): node is ts.CallExpression;
export declare function handlerBinding(
  registerSource: ts.SourceFile,
  capability: string,
): { module: string; exportName: string | null } | null;
export declare function agentHandlerModule(
  indexSource: ts.SourceFile,
  capability: string,
): string | null;
/** `text` with every comment blanked to spaces, newlines kept. */
export declare function withoutComments(fileName: string, text: string): string;
export declare function exportedNames(source: ts.SourceFile): string[];
export declare function soleHandlerExport(source: ts.SourceFile): string | null;

export interface RoleGateScanOptions {
  /** Function names whose call is a role gate, bare or as a member. */
  gates: readonly string[];
  /** Dotted property accesses that are a role read, e.g. `schema.orgUsers.role`. */
  propertyGates?: readonly string[];
  /** Resolves a relative import one hop; omit to stay in the one file. */
  followImport?: (
    spec: string,
    importedName: string,
  ) => { source: ts.SourceFile; exportName: string } | null;
  /**
   * Count a gate only where the reached code calls it. Off by default, so a
   * gate handed on as a value also counts.
   */
  requireCall?: boolean;
}

export declare function handlerCallsRoleGate(
  source: ts.SourceFile,
  exportName: string | null,
  options: RoleGateScanOptions,
): boolean;
