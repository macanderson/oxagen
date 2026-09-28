/**
 * role-gate-ast.mjs: the one reader of "does this handler reach a role gate".
 *
 * Two checks need the answer. INV-29's `packages/handlers/src/role-check.test.ts`
 * pins the handlers named in its arrays, and `tools/scripts/check-role-enforcement.mjs`
 * scans every contract that declares a role restriction. Both parse the handler
 * with the TypeScript compiler API and read only the code the handler reaches,
 * so a comment, a string, or an import that names a gate and is never used does
 * not count (#3490). Before this module the test held the AST reader and the
 * script held a whole-file regex, and the regex passed a handler that only
 * mentioned `assertOrgRole` in a comment.
 *
 * Kept as plain `.mjs` with a `.d.mts` beside it, so CI runs the script with bare
 * `node` and the test imports it by a relative path.
 */

import ts from "typescript";

/** Parse `text` as a TypeScript module, with parent pointers set. */
export function parseSource(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

/**
 * `a`, `a.b` or `a.b.c` for an identifier or a chain of property accesses,
 * or null for anything else (a call, an element access, `this`).
 */
export function dottedName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const head = dottedName(node.expression);
    return head === null ? null : `${head}.${node.name.text}`;
  }
  return null;
}

/**
 * Whether `node` is a call to the bare function `name`. A member call
 * (`real.assertOrgRole(…)`) does not match: INV-29's second rule reads the
 * direct calls a handler writes, not a wrapper forwarding to the real gate.
 */
export function isCallTo(node, name) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

/**
 * The `./module` and export name `register.ts` binds a capability to, or null.
 * Reads both shapes register.ts uses:
 * `(await import("./m")).fooHandler` and `import("./m").then((m) => m.fooHandler)`.
 * `exportName` is null when the loader names no export.
 */
export function handlerBinding(registerSource, capability) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerHandler" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === capability
    ) {
      const text = node.arguments[1]?.getText(registerSource) ?? "";
      const module = /import\(\s*["'](\.\/[^"']+)["']\s*\)/.exec(text)?.[1];
      const exportName =
        /\)\)\s*\.(\w+)/.exec(text)?.[1] ??
        /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(?\s*\1\.(\w+)/.exec(text)?.[2] ??
        null;
      if (module) found = { module, exportName };
    }
    ts.forEachChild(node, visit);
  };
  visit(registerSource);
  return found;
}

/**
 * The `./module` packages/agent's `LOADERS` entry for a capability imports,
 * or null when LOADERS does not name it.
 */
export function agentHandlerModule(indexSource, capability) {
  let module = null;
  const visit = (node) => {
    if (module) return;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === capability
    ) {
      module =
        /import\(\s*["'](\.\/[^"']+)["']\s*\)/.exec(
          node.initializer.getText(indexSource),
        )?.[1] ?? null;
    }
    ts.forEachChild(node, visit);
  };
  visit(indexSource);
  return module;
}

const isExported = (node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );

/** Every name a module exports from its own top-level declarations. */
export function exportedNames(source) {
  const names = [];
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    }
  }
  return names;
}

/**
 * The module's one exported `*Handler`, which is how `resolveHandler` in
 * packages/agent/src/handlers/index.ts resolves a snake_case capability, or
 * null when the module exports none or more than one.
 */
export function soleHandlerExport(source) {
  const handlers = exportedNames(source).filter((n) => n.endsWith("Handler"));
  return handlers.length === 1 ? handlers[0] : null;
}

/**
 * The top-level declaration named `name` in `source`, as the node whose body
 * or initializer a scan reads: a function declaration, a variable's
 * initializer, or `export default`'s expression. Null when there is none.
 */
function topLevelDeclaration(source, name) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const isDefault = (ts.getModifiers(statement) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (statement.name?.text === name || (name === "default" && isDefault)) {
        return statement;
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === name &&
          decl.initializer
        ) {
          return decl.initializer;
        }
      }
    }
    if (
      name === "default" &&
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals
    ) {
      return statement.expression;
    }
  }
  return null;
}

/**
 * The imports of `source`: `aliases` maps each local name of a named or
 * default import to the name it imports (`resolveActorOrgRole as
 * resolveActorRole` maps `resolveActorRole` to `resolveActorOrgRole`), and
 * `relative` maps each local name imported by a relative path to
 * `{ spec, imported }`. Type-only imports are left out of both.
 */
function importsOf(source) {
  const aliases = new Map();
  const relative = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = statement.moduleSpecifier.text;
    const isRelative = spec.startsWith(".");
    const add = (local, imported) => {
      aliases.set(local, imported);
      if (isRelative) relative.set(local, { spec, imported });
    };
    if (clause.name) add(clause.name.text, "default");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (!el.isTypeOnly)
          add(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
  }
  return { aliases, relative };
}

/**
 * Whether an identifier stands for a value here, rather than naming a
 * declaration or a property. `{ actingUser }` is a value; the key of
 * `{ orgRole: x }`, the `b` of `a.b`, and the name of `const a = …` are not.
 */
function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  return parent.name !== node && parent.propertyName !== node;
}

/**
 * Whether the export `exportName` of `source` reaches a role gate.
 *
 * The scan starts at the export's declaration: its body when it is a function
 * declaration, its initializer when it is a variable, the expression of
 * `export default`. It reads code, never comments or strings, and it never
 * reads the import list itself, so a gate named only in a comment or an unused
 * import does not count (#3490). A gate counts when the reached code calls it
 * or hands it on as a value (`roles: { orgRole: resolveActorOrgRole }`, the
 * dependency object a handler then calls): by its own name, by an import alias
 * of it, or as a member (`iam.assertOrgRole`). A property access counts when
 * its dotted name is one of `propertyGates` (`schema.orgUsers.role`, the column
 * an inline role check selects). Type annotations are skipped.
 *
 * The scan follows what the handler calls or refers to:
 *
 * - a same-file top-level function or variable, however deep, each once, so a
 *   factory (`export const h = createH(deps)`), a local helper, or a function
 *   passed in a dependency object is read;
 * - when `followImport` is given, a value imported by a relative path, one
 *   hop. `followImport(spec, importedName)` returns the parsed module and the
 *   export to read, or null. The imported module's own same-file helpers are
 *   read too; its imports are not.
 *
 * @param {import("typescript").SourceFile} source
 * @param {string | null} exportName null reads every export the module declares
 * @param {{
 *   gates: readonly string[],
 *   propertyGates?: readonly string[],
 *   followImport?: (spec: string, importedName: string) =>
 *     { source: import("typescript").SourceFile, exportName: string } | null,
 * }} options
 * @returns {boolean}
 */
export function handlerCallsRoleGate(source, exportName, options) {
  const { gates, propertyGates = [], followImport } = options;
  const gateSet = new Set(gates);
  const propertySet = new Set(propertyGates);

  const reaches = (file, names, hopsLeft) => {
    const { aliases, relative } = importsOf(file);
    const seen = new Set();
    const followed = new Set();
    const queue = [];
    const enqueue = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      const decl = topLevelDeclaration(file, name);
      if (decl) queue.push(decl);
    };
    // A relative import, read one hop deep and only once per name.
    const follow = (name) => {
      if (hopsLeft <= 0 || !followImport || followed.has(name)) return false;
      const binding = relative.get(name);
      if (!binding) return false;
      followed.add(name);
      const target = followImport(binding.spec, binding.imported);
      return target !== null && reaches(target.source, [target.exportName], 0);
    };

    let hit = false;
    const visit = (node) => {
      if (hit || ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) && isValueReference(node)) {
        const name = node.text;
        if (gateSet.has(aliases.get(name) ?? name)) {
          hit = true;
          return;
        }
        if (topLevelDeclaration(file, name)) enqueue(name);
        else if (follow(name)) {
          hit = true;
          return;
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (
          gateSet.has(node.name.text) ||
          (propertySet.size > 0 && propertySet.has(dottedName(node) ?? ""))
        ) {
          hit = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    for (const name of names) enqueue(name);
    while (queue.length > 0 && !hit) visit(queue.shift());
    return hit;
  };

  const names = exportName === null ? exportedNames(source) : [exportName];
  return reaches(source, names, 1);
}
