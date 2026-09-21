#!/usr/bin/env tsx
/**
 * check-inngest-senders.ts — every Inngest trigger must have a sender.
 *
 * A durable function subscribes to an event name. No type connects that name to
 * the code that sends it, and none can: the client's event schema says what a
 * valid event looks like, never that anything constructs one. So a trigger on
 * an event nobody sends compiles, lints, tests and deploys, then sits in the
 * registered function list looking like a live retry path.
 *
 * That is #2823's third finding. `chat.persist-stream` subscribes to
 * `chat/message.streamed` with `retries: 3`, its spec describes terminal
 * persistence for a streamed assistant turn, and no code path has ever sent
 * the event — so the durability it advertises has never once been exercised.
 * The two `stripe.sync-*` functions are the same shape: the webhook route
 * handles those Stripe events inline through `processStripeEvent` instead.
 *
 * A trigger with no sender is worse than a missing function: the missing one
 * is visible, and this one reads as delivered work.
 *
 * Run via `pnpm check:inngest-senders`; wired into `pnpm gate`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Concrete registrations live here. The parent directory contains runtime forwarders. */
const TRIGGER_ROOT = join(ROOT, "packages/inngest-functions/src/functions");

/** Where a sender may live. */
const SENDER_ROOTS = ["apps", "packages", "tools"].map((d) => join(ROOT, d));

/**
 * Inngest emits its own lifecycle events into the same namespace — a function
 * failing produces `inngest/function.failed`, which is what the on-failure
 * companion in create-function.ts and observability.capture-failure subscribe
 * to. The platform is the sender, so no code in this repository sends them and
 * none should. This is a rule about who emits the namespace, not a list of
 * events excused from the check.
 */
const PLATFORM_EVENT_PREFIX = "inngest/";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".vercel",
  ".xmcp",
  "coverage",
  "out",
  "build",
  "e2e",
  "__tests__",
]);

/** Where one trigger was declared. */
export interface Trigger {
  event: string;
  /** `path:line`, relative to the repository root. */
  location: string;
}

/** Source files a scan should read: TypeScript, excluding tests. */
export function sourceFiles(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) sourceFiles(full, results);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
      results.push(full);
  }
  return results;
}

type ResolveEvent = (
  node: ts.Expression,
  source: ts.SourceFile,
) => string | undefined;

/** Resolve literal constants through named imports and re-exports without executing source. */
export function eventResolver(
  load: (file: string) => string = (file) => readFileSync(file, "utf8"),
  resolveImport: (name: string, file: string) => string | undefined = (
    name,
    file,
  ) =>
    ts.resolveModuleName(
      name,
      file,
      {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
      },
      ts.sys,
    ).resolvedModule?.resolvedFileName,
): ResolveEvent {
  const parsed = new Map<string, ts.SourceFile>();
  function sourceAt(file: string): ts.SourceFile {
    let source = parsed.get(file);
    if (!source) {
      source = ts.createSourceFile(
        file,
        load(file),
        ts.ScriptTarget.Latest,
        true,
      );
      parsed.set(file, source);
    }
    return source;
  }
  function exported(
    file: string,
    name: string,
    seen: Set<string>,
  ): string | undefined {
    const source = sourceAt(file);
    for (const statement of source.statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        );
        if (
          declaration?.initializer &&
          statement.declarationList.flags & ts.NodeFlags.Const
        )
          return value(declaration.initializer, source, seen);
      }
      if (!ts.isExportDeclaration(statement)) continue;
      const target =
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveImport(statement.moduleSpecifier.text, file)
          : undefined;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const binding = statement.exportClause.elements.find(
          (e) => e.name.text === name,
        );
        if (binding) {
          const original = binding.propertyName?.text ?? binding.name.text;
          return target
            ? named(original, sourceAt(target), seen, true)
            : named(original, source, seen);
        }
      } else if (!statement.exportClause && target) {
        const result = named(name, sourceAt(target), seen, true);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }
  function named(
    name: string,
    source: ts.SourceFile,
    seen: Set<string>,
    onlyExported = false,
  ): string | undefined {
    const key = `${source.fileName}:${name}:${onlyExported}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    if (onlyExported) return exported(source.fileName, name, next);
    for (const statement of source.statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      ) {
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        );
        if (declaration?.initializer)
          return value(declaration.initializer, source, next);
      }
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const imports = statement.importClause?.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) continue;
      const binding = imports.elements.find((e) => e.name.text === name);
      const target =
        binding &&
        resolveImport(statement.moduleSpecifier.text, source.fileName);
      if (binding && target)
        return named(
          binding.propertyName?.text ?? binding.name.text,
          sourceAt(target),
          next,
          true,
        );
    }
    return undefined;
  }
  function value(
    node: ts.Expression,
    source: ts.SourceFile,
    seen: Set<string>,
  ): string | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return value(node.expression, source, seen);
    if (ts.isIdentifier(node)) {
      // A local binding must not borrow an identically named module constant.
      for (
        let parent = node.parent;
        parent && parent !== source;
        parent = parent.parent
      ) {
        const binds = (name: ts.BindingName): boolean =>
          ts.isIdentifier(name)
            ? name.text === node.text
            : name.elements.some(
                (element) =>
                  !ts.isOmittedExpression(element) && binds(element.name),
              );
        if (
          ts.isFunctionLike(parent) &&
          parent.parameters.some((p) => binds(p.name))
        )
          return undefined;
        if (
          ts.isCatchClause(parent) &&
          parent.variableDeclaration &&
          binds(parent.variableDeclaration.name)
        )
          return undefined;
        if (
          ts.isBlock(parent) &&
          parent.statements.some(
            (statement) =>
              ts.isVariableStatement(statement) &&
              statement.declarationList.declarations.some((d) => binds(d.name)),
          )
        )
          return undefined;
      }
      return named(node.text, source, seen);
    }
    return undefined;
  }
  return (node, source) => value(node, source, new Set());
}

function callName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined;
}

/** Read actual registration and wait calls, ignoring comments and forwarding object shapes. */
export function triggersIn(
  source: string,
  relPath: string,
  resolveEvent = eventResolver(),
): Trigger[] {
  const parsed = ts.createSourceFile(
    relPath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Trigger[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "createFunction") ||
        callName(node) === "waitForEvent")
    ) {
      const trigger = node.arguments[1];
      if (trigger) {
        if (
          !ts.isObjectLiteralExpression(trigger) &&
          !ts.isArrayLiteralExpression(trigger)
        )
          throw new Error(
            `${relPath}: cannot resolve the event trigger expression`,
          );
        const inspect = (part: ts.Node): void => {
          if (ts.isArrayLiteralExpression(part)) {
            for (const element of part.elements) inspect(element);
            return;
          }
          if (!ts.isObjectLiteralExpression(part))
            throw new Error(
              `${relPath}: cannot resolve the event trigger expression`,
            );
          for (const property of part.properties) {
            if (ts.isSpreadAssignment(property))
              throw new Error(
                `${relPath}: cannot resolve a spread event trigger`,
              );
            if (property.name?.getText(parsed).replace(/["']/g, "") !== "event")
              continue;
            const line =
              parsed.getLineAndCharacterOfPosition(property.getStart(parsed))
                .line + 1;
            const expression = ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? property.name
                : undefined;
            const event = expression && resolveEvent(expression, parsed);
            if (event === undefined)
              throw new Error(
                `${relPath}:${line}: cannot resolve the event trigger name`,
              );
            found.push({ event, location: `${relPath}:${line}` });
          }
        };
        inspect(trigger);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

/** A sender file must contain a send call; names may be built earlier in that file. */
export function sendersIn(
  source: string,
  file = "sender.ts",
  resolveEvent = eventResolver(),
): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  let sends = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ["send", "sendEvent"].includes(callName(node) ?? "")
    )
      sends = true;
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(parsed).replace(/["']/g, "") === "name"
    ) {
      const name = resolveEvent(node.initializer, parsed);
      if (name !== undefined) names.push(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return sends ? names : [];
}

/** Triggers whose event nothing sends. */
export function orphans(
  triggers: readonly Trigger[],
  sent: ReadonlySet<string>,
): Trigger[] {
  return triggers.filter(
    (t) => !t.event.startsWith(PLATFORM_EVENT_PREFIX) && !sent.has(t.event),
  );
}

function main(): void {
  const triggers: Trigger[] = [];
  const resolveEvent = eventResolver();
  for (const file of sourceFiles(TRIGGER_ROOT)) {
    triggers.push(
      ...triggersIn(readFileSync(file, "utf8"), file, resolveEvent).map(
        (trigger) => ({
          ...trigger,
          location: relative(ROOT, trigger.location),
        }),
      ),
    );
  }

  // An empty trigger set would pass silently while proving nothing — the same
  // shape of lie this guard exists to catch. The functions directory is the
  // durable-function surface; if it yields no trigger, the parser has lost the
  // shape it reads, not the repository its functions.
  if (triggers.length === 0) {
    stdout.write(
      `check:inngest-senders: no concrete event trigger found in ${relative(ROOT, TRIGGER_ROOT)}. ` +
        "Restore the registrations or update the parser before relying on this check.\n",
    );
    exit(1);
  }

  const sent = new Set<string>();
  for (const root of SENDER_ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const name of sendersIn(
        readFileSync(file, "utf8"),
        file,
        resolveEvent,
      ))
        sent.add(name);
    }
  }

  const dead = orphans(triggers, sent);

  if (dead.length > 0) {
    stdout.write(
      `check:inngest-senders — ${dead.length} trigger(s) subscribe to an event ` +
        `nothing in this repository sends:\n` +
        dead.map((d) => `  ${d.event}\n    ${d.location}\n`).join("") +
        `\nThe function is registered and will never run. Send the event from ` +
        `the code path that should fire it, or delete the function.\n`,
    );
    exit(1);
  }

  stdout.write(
    `check:inngest-senders — ${triggers.length} triggers, every event sent ` +
      `somewhere in the tree.\n`,
  );
}

// pathToFileURL, not string concatenation: a repo path containing a space or a
// non-ASCII character percent-encodes in `import.meta.url` but not in argv[1],
// and the mismatch would make this guard a silent no-op that exits 0.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
