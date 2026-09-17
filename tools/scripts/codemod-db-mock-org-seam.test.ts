/**
 * The recognised-form corpus for `check:db-mock-seams`.
 *
 * The check decides ONE syntactic question — does the `vi.mock("@oxagen/database")`
 * factory that substitutes `withTenantDb` also substitute `withOrgDb` — and its
 * whole claim to be worth having, unlike the static checker ADR-086 retired, is
 * that the parse settles it. That claim is only as good as the SET of spellings
 * the parse is read for. The first version read `PropertyAssignment` with an
 * `Identifier` name and nothing else, so `{ ...real, withTenantDb }` was
 * invisible to it and `packages/billing/src/metering.test.ts` reported clean
 * while leaving the real `withOrgDb` installed.
 *
 * So every recognised form gets BOTH fixtures:
 *
 *   • a REJECTED one — the form substitutes `withTenantDb` and not `withOrgDb`,
 *     and the check must produce a rewrite. Without one of these per form the
 *     check cannot fail on that form at all, which is how the shorthand bug
 *     lived.
 *   • an ACCEPTED one — the same form also substitutes `withOrgDb`, and the
 *     check must produce nothing. Without one of these a check could "pass" by
 *     rejecting everything.
 *
 * The forms deliberately left OUT of the set get a third kind of fixture: they
 * must be REPORTED as a skip, never counted clean. A blind spot that names
 * itself is a different object from one that does not.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assigns,
  databaseMockCalls,
  rewrite,
} from "./codemod-db-mock-org-seam.mjs";

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile(
    "fixture.test.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

/** `{ changed, skips }` for a fixture, plus the rewritten text. */
function check(body: string) {
  const text = `import { vi } from "vitest";\n${body}\n`;
  const sourceFile = parse(text);
  const result = rewrite(text, sourceFile) as {
    text: string;
    changed: number;
    skips: string[];
  };
  return result;
}

/** A factory whose return carries `props`, wrapped in the real mock call shape. */
const factory = (props: string, prelude = "") =>
  `vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
${prelude}  return { ...real, ${props} };
});`;

/**
 * Every spelling the check must READ. `tenant` substitutes withTenantDb alone
 * (must be rejected); `both` substitutes withOrgDb as well (must be accepted).
 */
const RECOGNISED: readonly {
  form: string;
  tenant: string;
  both: string;
  prelude?: string;
}[] = [
  {
    form: "PropertyAssignment with an identifier name",
    tenant: "withTenantDb: mocks.withTenantDb",
    both: "withTenantDb: mocks.withTenantDb, withOrgDb: mocks.withTenantDb",
  },
  {
    // packages/billing/src/metering.test.ts:79 was exactly this, and the check
    // reported success over it. Pinned so it cannot pass on it again.
    form: "ShorthandPropertyAssignment",
    tenant: "withTenantDb",
    both: "withTenantDb, withOrgDb",
  },
  {
    form: "PropertyAssignment with a string-literal name",
    tenant: '"withTenantDb": mocks.withTenantDb',
    both: '"withTenantDb": mocks.withTenantDb, "withOrgDb": mocks.withTenantDb',
  },
  {
    // `{ `a`: 1 }` is not a thing — a template literal is not a PropertyName in
    // an object literal, it parses as a tagged template. A template inside a
    // COMPUTED name is, and the check reads it.
    form: "ComputedPropertyName over a no-substitution template",
    tenant: "[`withTenantDb`]: mocks.withTenantDb",
    both: "[`withTenantDb`]: mocks.withTenantDb, [`withOrgDb`]: mocks.withTenantDb",
  },
  {
    form: "ComputedPropertyName over a string literal",
    tenant: '["withTenantDb"]: mocks.withTenantDb',
    both: '["withTenantDb"]: mocks.withTenantDb, ["withOrgDb"]: mocks.withTenantDb',
  },
  {
    form: "MethodDeclaration",
    tenant:
      "async withTenantDb(fn: (tx: unknown) => unknown) { return fn({}); }",
    both: "async withTenantDb(fn: (tx: unknown) => unknown) { return fn({}); }, async withOrgDb(fn: (tx: unknown) => unknown) { return fn({}); }",
  },
  {
    form: "GetAccessorDeclaration",
    tenant: "get withTenantDb() { return mocks.withTenantDb; }",
    both: "get withTenantDb() { return mocks.withTenantDb; }, get withOrgDb() { return mocks.withTenantDb; }",
  },
  {
    // The shape this codemod EMITS. Not resolving it meant the check could not
    // read its own output.
    form: "SpreadAssignment of a same-file const object literal",
    prelude: "  const seams = { withTenantDb: mocks.withTenantDb };\n",
    tenant: "...seams",
    both: "...seams, withOrgDb: mocks.withTenantDb",
  },
];

describe("the recognised forms — every one rejects and accepts", () => {
  it.each(RECOGNISED)("rejects $form", ({ tenant, prelude }) => {
    const r = check(factory(tenant, prelude));
    expect(r.changed).toBe(1);
    expect(r.skips).toEqual([]);
    // The rewrite binds rather than duplicates: one identity for both seams,
    // which is what api.key.create.test.ts's "called twice" assertion needs.
    expect(r.text).toContain(
      "return { ...dbMock, withOrgDb: dbMock.withTenantDb };",
    );
  });

  it.each(RECOGNISED)("accepts $form", ({ both, prelude }) => {
    const r = check(factory(both, prelude));
    expect(r.changed).toBe(0);
    expect(r.skips).toEqual([]);
  });

  it("covers every form with both a rejecting and an accepting fixture", () => {
    // 8 forms × 2 fixtures. A checker with no accepting fixture can pass by
    // rejecting everything; one with no rejecting fixture cannot fail at all.
    expect(RECOGNISED).toHaveLength(8);
    expect(new Set(RECOGNISED.map((f) => f.form)).size).toBe(8);
  });
});

describe("transitive and nested spreads", () => {
  it("follows a spread of a const that spreads another const", () => {
    const r = check(
      factory(
        "...outer",
        "  const inner = { withTenantDb: mocks.t };\n  const outer = { ...inner };\n",
      ),
    );
    expect(r.changed).toBe(1);
  });

  it("accepts when the alias arrives through the nested const", () => {
    const r = check(
      factory(
        "...outer",
        "  const inner = { withTenantDb: mocks.t };\n  const outer = { ...inner, withOrgDb: mocks.t };\n",
      ),
    );
    expect(r.changed).toBe(0);
    expect(r.skips).toEqual([]);
  });

  it("does not loop on a const that spreads itself", () => {
    const r = check(
      factory(
        "...loop",
        "  const loop = { ...loop, withTenantDb: mocks.t };\n",
      ),
    );
    // Whatever it decides, it terminates — that is the assertion.
    expect(typeof r.changed).toBe("number");
  });

  it("reads an inline object-literal spread", () => {
    const r = check(factory("...{ withTenantDb: mocks.t }"));
    expect(r.changed).toBe(1);
  });
});

describe("the forms deliberately outside the set are reported, not counted clean", () => {
  it("reports a non-literal computed key", () => {
    const r = check(factory("[key]: mocks.withTenantDb"));
    expect(r.changed).toBe(0);
    expect(r.skips.join(" ")).toContain("cannot read");
  });

  it("reports a spread of something neither local nor importOriginal", () => {
    const r = check(factory("...fromSomewhereElse"));
    expect(r.changed).toBe(0);
    expect(r.skips.join(" ")).toContain("cannot read");
  });

  it("reports a factory whose own return is not an object literal", () => {
    const r = check(
      `vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return Object.assign({}, real, { withTenantDb: mocks.withTenantDb });
});`,
    );
    expect(r.changed).toBe(0);
    expect(r.skips.join(" ")).toContain("cannot read");
  });

  it("does NOT report a spread of importOriginal, which carries only real seams", () => {
    // ~300 factories in this repo spread `real`. Reporting those would bury the
    // report that matters, and `real` is by construction the thing that leaves
    // withOrgDb REAL, never the thing that substitutes withTenantDb.
    const r = check(factory("withTenantDb: mocks.t, withOrgDb: mocks.t"));
    expect(r.skips).toEqual([]);
    const inline = check(
      `vi.mock("@oxagen/database", async (importOriginal) => {
  return { ...(await importOriginal<typeof import("@oxagen/database")>()) };
});`,
    );
    expect(inline.skips).toEqual([]);
  });

  it("ignores a set accessor, which binds no readable value", () => {
    const r = check(factory("set withTenantDb(v: unknown) { mocks.v = v; }"));
    expect(r.changed).toBe(0);
  });
});

describe("what the check looks at", () => {
  it("reads vi.mock and vi.doMock on @oxagen/database and nothing else", () => {
    const sf = parse(`
      vi.mock("@oxagen/database", () => ({}));
      vi.doMock("@oxagen/database", () => ({}));
      vi.mock("@oxagen/tenancy", () => ({}));
      vi.mock(specifier, () => ({}));
      other.mock("@oxagen/database", () => ({}));
    `);
    expect(databaseMockCalls(sf)).toHaveLength(2);
  });

  it("leaves a concise arrow body a block it can bind a const in", () => {
    const r = check(
      `vi.mock("@oxagen/database", async () => ({ withTenantDb: mocks.t }));`,
    );
    expect(r.changed).toBe(1);
    expect(r.text).toContain("const dbMock = { withTenantDb: mocks.t };");
    expect(r.text).toContain(
      "return { ...dbMock, withOrgDb: dbMock.withTenantDb };",
    );
  });

  it("does not mistake a builder's inner return for the factory's", () => {
    // 300-odd `return Object.assign(Promise.resolve(rows), chain)` lines sit
    // inside these factories. Reporting them would make the skip channel noise.
    const r = check(
      `vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = { select: () => { return Object.assign(Promise.resolve([]), {}); } };
  return { ...real, withTenantDb: mocks.t, withOrgDb: mocks.t, tx };
});`,
    );
    expect(r.changed).toBe(0);
    expect(r.skips).toEqual([]);
  });
});

describe("assigns, directly", () => {
  const literal = (src: string): ts.ObjectLiteralExpression => {
    const sf = parse(`const x = ${src};`);
    const [decl] = (sf.statements[0] as ts.VariableStatement).declarationList
      .declarations;
    if (decl?.initializer === undefined) throw new Error("bad fixture");
    return decl.initializer as ts.ObjectLiteralExpression;
  };

  it("treats the two spellings JavaScript treats as identical identically", () => {
    const sf = parse("");
    const shorthand = assigns(literal("{ withOrgDb }"), "withOrgDb", sf) as {
      yes: boolean;
    };
    const longhand = assigns(
      literal("{ withOrgDb: withOrgDb }"),
      "withOrgDb",
      sf,
    ) as { yes: boolean };
    expect(shorthand.yes).toBe(true);
    expect(longhand.yes).toBe(true);
  });

  it("marks an unreadable member undecided rather than absent", () => {
    const sf = parse("");
    const r = assigns(literal("{ [k]: f }"), "withOrgDb", sf) as {
      yes: boolean;
      undecided: boolean;
    };
    expect(r).toEqual({ yes: false, undecided: true });
  });
});
