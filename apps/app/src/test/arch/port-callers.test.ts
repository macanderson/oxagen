// INV-17 (ARCHITECTURE.md §3.3, §4): every DataSource method has a production
// caller in src/features/** or src/app/**, called as `….<port>.<method>(…)`.
// A method nothing calls, or only a test calls, is unbound and fails; a port
// the test cannot read as an object type fails rather than passing unread.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  isTestOnly,
  lineOf,
  listFiles,
  parse,
  readSource,
  WHOLE_TREE_TIMEOUT_MS,
  type SourceText,
} from "./parse";

const RULE = "port-callers";
const PORTS_FILE = "src/data/ports.ts";
// ADR-130 / DEREGISTERED.md §15: the chain reader is retained for the
// excluded replay UI. Keep this exception exact; all other ports need callers.
const RETAINED_PORTS = new Set(["runs.chain"]);
const PROBES = "src/test/arch/probes/port-callers";

type Ports = { readonly methods: string[]; readonly unreadable: string[] };

/** `port.method` for every method of `interface DataSource`. */
function portsOf(source: SourceText): Ports {
  const sf = parse(source);
  const methods: string[] = [];
  const unreadable: string[] = [];
  for (const statement of sf.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      statement.name.text !== "DataSource"
    ) {
      continue;
    }
    for (const port of statement.members) {
      const name = port.name?.getText(sf) ?? "<unnamed>";
      if (
        !ts.isPropertySignature(port) ||
        port.type === undefined ||
        !ts.isTypeLiteralNode(port.type)
      ) {
        unreadable.push(
          `${RULE} ${source.file}:${String(lineOf(sf, port))} unreadable-port ${name}`,
        );
        continue;
      }
      for (const method of port.type.members) {
        methods.push(`${name}.${method.name?.getText(sf) ?? "<unnamed>"}`);
      }
    }
  }
  return { methods, unreadable };
}

/** The modules whose calls count: production modules under src/features and src/app. */
function callerFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      (file.startsWith("src/features/") || file.startsWith("src/app/")) &&
      /\.tsx?$/.test(file) &&
      !isTestOnly(file),
  );
}

/** Every `….<port>.<method>(…)` call in a module, as `port.method`. */
function callsIn(source: SourceText): Set<string> {
  const sf = parse(source);
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      calls.add(
        `${node.expression.expression.name.text}.${node.expression.name.text}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

function portCallerViolations(
  ports: SourceText,
  callers: readonly SourceText[],
  retained: ReadonlySet<string> = new Set(),
): string[] {
  const { methods, unreadable } = portsOf(ports);
  const called = new Set(callers.flatMap((caller) => [...callsIn(caller)]));
  return [
    ...unreadable,
    ...methods
      .filter((method) => !called.has(method) && !retained.has(method))
      .map((method) => `${RULE} ${ports.file} ${method} no-caller`),
  ];
}

describe("port callers", () => {
  it(
    "every active DataSource method has a production caller in src/features or src/app",
    () => {
      const callers = callerFiles(listFiles("src")).map(readSource);
      expect(portsOf(readSource(PORTS_FILE)).methods.length).toBeGreaterThan(0);
      const ports = readSource(PORTS_FILE);
      expect(
        [...RETAINED_PORTS].every((method) =>
          portsOf(ports).methods.includes(method),
        ),
      ).toBe(true);
      expect(portCallerViolations(ports, callers, RETAINED_PORTS)).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "the pretenant port's callers are exactly the / landing and the CLI consent page (§3.3)",
    () => {
      const callers = callerFiles(listFiles("src")).filter((file) =>
        [...callsIn(readSource(file))].some((call) =>
          call.startsWith("pretenant."),
        ),
      );
      expect(callers.sort()).toEqual([
        "src/features/auth/cli-consent.ts",
        "src/features/shell/landing.ts",
      ]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("a port method with no caller fails; called methods pass", () => {
    expect(
      portCallerViolations(readSource(`${PROBES}/ports.ts`), [
        readSource(`${PROBES}/fleet.tsx`),
        readSource(`${PROBES}/shell.ts`),
      ]),
    ).toEqual([`${RULE} ${PROBES}/ports.ts runs.get no-caller`]);
  });

  it("a port typed by name cannot be read and fails", () => {
    expect(
      portCallerViolations(readSource(`${PROBES}/named-port-type.ts`), []),
    ).toEqual([`${RULE} ${PROBES}/named-port-type.ts:4 unreadable-port runs`]);
  });

  it("only production modules under src/features and src/app count as callers (negative)", () => {
    expect(
      callerFiles([
        "src/app/[org]/[ws]/page.tsx",
        "src/features/run/stream.ts",
        "src/features/run/runs.test.tsx",
        "src/features/run/run.builders.ts",
        "src/data/live/runs.ts",
        "src/server/kernel.ts",
        "src/test/arch/probes/port-callers/fleet.tsx",
        "src/features/run/messages.json",
      ]),
    ).toEqual(["src/app/[org]/[ws]/page.tsx", "src/features/run/stream.ts"]);
  });
});
