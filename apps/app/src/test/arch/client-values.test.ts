// Client values stay on the client (INV-21, second half): a module without the
// "use client" directive never imports a value other than a component from a
// "use client" module. On the server, every export of a "use client" module is
// a client reference. A component can be rendered from one, but calling a
// function through one throws ("Attempted to call keyPrefixOf() from the
// server but keyPrefixOf is on the client"). Neither tsc, the build nor a
// vitest render catches that; only a request does. On 2026-09-24 the Agents
// page threw it on every load while its e2e row still passed.
//
// A component is named in PascalCase, so a lowercase import is a value the
// importer means to call or read. Type-only imports are erased and pass.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_DIR,
  directiveOf,
  importEdges,
  parse,
  productionFiles,
  readSource,
  resolveInternal,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

type DirectiveOfModule = (modulePath: string) => string | null;

/** A binding that is a value a server module would call or read: not a component, a namespace or a default. */
const isCalledValue = (name: string): boolean =>
  name !== "*" && name !== "default" && !/^[A-Z]/.test(name);

/** `<file>:<line> <specifier> <name>` for every client value `source` imports without being a client module itself. */
function clientValueImports(
  source: SourceText,
  directiveOfModule: DirectiveOfModule,
): string[] {
  const sf = parse(source);
  if (directiveOf(sf) === "use client") return [];
  const out: string[] = [];
  for (const edge of importEdges(sf)) {
    if (edge.typeOnly || edge.computed) continue;
    const target = resolveInternal(source.file, edge.specifier);
    if (target?.kind !== "module") continue;
    if (directiveOfModule(target.path) !== "use client") continue;
    for (const name of edge.names.filter(isCalledValue)) {
      out.push(
        `${source.file}:${String(edge.line)} ${edge.specifier} ${name}`,
      );
    }
  }
  return out;
}

const directives = new Map<string, string | null>();

/** The directive of the module at `src/<modulePath>.ts(x)`, or null when no such file exists. */
function directiveOnDisk(modulePath: string): string | null {
  const cached = directives.get(modulePath);
  if (cached !== undefined) return cached;
  const file = [".ts", ".tsx"]
    .map((ext) => `src/${modulePath}${ext}`)
    .find((candidate) => existsSync(path.join(APP_DIR, candidate)));
  const directive =
    file === undefined ? null : directiveOf(parse(readSource(file)));
  directives.set(modulePath, directive);
  return directive;
}

describe("client values stay on the client", () => {
  const clientModules: DirectiveOfModule = (modulePath) =>
    modulePath === "features/agents/key-prefix" ? "use client" : null;
  const judge = (text: string, file = "src/features/agents/agents.tsx") =>
    clientValueImports({ file, text }, clientModules);

  it("refuses a server module calling a function a client module exports", () => {
    expect(
      judge('import { AgentKeyPrefix, keyPrefixOf } from "./key-prefix";'),
    ).toEqual([
      "src/features/agents/agents.tsx:1 ./key-prefix keyPrefixOf",
    ]);
  });

  it("allows components, types and the client module's own client importers", () => {
    expect(judge('import { AgentKeyPrefix } from "./key-prefix";')).toEqual([]);
    expect(
      judge('import { type Prefix, AgentKeyPrefix } from "./key-prefix";'),
    ).toEqual([]);
    expect(judge('import type { prefixOf } from "./key-prefix";')).toEqual([]);
    expect(
      judge('"use client";\nimport { useAgentKeyPrefix } from "./key-prefix";'),
    ).toEqual([]);
    expect(judge('import { keyPrefixOf } from "./key-prefix-of";')).toEqual(
      [],
    );
  });

  it(
    "holds over every production module",
    () => {
      const found = productionFiles()
        .filter((file) => file.startsWith("src/"))
        .flatMap((file) => clientValueImports(readSource(file), directiveOnDisk));
      expect(found).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );
});
