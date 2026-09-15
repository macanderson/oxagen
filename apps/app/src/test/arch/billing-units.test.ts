// INV-25 (ARCHITECTURE.md §3.9, §4): on the Billing page money renders only in
// the contracted rate, the invoices and the purchase form's total, and every
// other figure is a GAU count. Three readings of the tree:
//   - `<Money` JSX under src/features/billing/** appears in contract-rate.tsx,
//     invoices.tsx and purchase-form.tsx alone;
//   - of the zod view models src/data/contracts/billing.ts exports, only
//     ContractRate and InvoicePage reach `Money`, directly or through a local
//     schema;
//   - src/data/live/mappers/billing.ts never names get_subscription's credit
//     balance or token cost, as an identifier or as a string key. The denylist
//     is two fixed names, since the mapper reads ratePerGauMicros and
//     amountDueMicros and a `*Micros*` wildcard would refuse it.
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  isTestOnly,
  lineOf,
  listFiles,
  parse,
  readSource,
  type SourceText,
} from "./parse";

const RULE = "billing-units";
const FEATURE_DIR = "src/features/billing";
const CONTRACTS_FILE = "src/data/contracts/billing.ts";
const MAPPER_FILE = "src/data/live/mappers/billing.ts";
const PROBES = "src/test/arch/probes/billing-units";

const MONEY_COMPONENTS: ReadonlySet<string> = new Set([
  "contract-rate.tsx",
  "invoices.tsx",
  "purchase-form.tsx",
]);
const MONEY_VIEW_MODELS: ReadonlySet<string> = new Set([
  "ContractRate",
  "InvoicePage",
]);
const DENIED_NAMES: ReadonlySet<string> = new Set([
  "creditBalanceCents",
  "costMicros",
]);

function moneyJsxViolations(source: SourceText): string[] {
  if (MONEY_COMPONENTS.has(path.posix.basename(source.file))) return [];
  const sf = parse(source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "Money"
    ) {
      violations.push(
        `${RULE} ${source.file}:${String(lineOf(sf, node))} money-outside-rate-and-invoices`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function referencesAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node) && names.has(node.text)) return true;
  return (
    ts.forEachChild(
      node,
      (child) => referencesAny(child, names) || undefined,
    ) ?? false
  );
}

function viewModelViolations(source: SourceText): string[] {
  const sf = parse(source);
  const declarations: {
    name: string;
    node: ts.VariableDeclaration;
    initializer: ts.Expression;
    exported: boolean;
  }[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    for (const node of statement.declarationList.declarations) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        declarations.push({
          name: node.name.text,
          node,
          initializer: node.initializer,
          exported,
        });
      }
    }
  }
  // Grow the set of schemas that reach Money until no local schema adds one.
  const carriers = new Set(["Money"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, initializer } of declarations) {
      if (!carriers.has(name) && referencesAny(initializer, carriers)) {
        carriers.add(name);
        grew = true;
      }
    }
  }
  return declarations
    .filter(
      ({ name, exported }) =>
        exported && carriers.has(name) && !MONEY_VIEW_MODELS.has(name),
    )
    .map(
      ({ name, node }) =>
        `${RULE} ${source.file}:${String(lineOf(sf, node))} money-in-view-model:${name}`,
    );
}

function mapperViolations(source: SourceText): string[] {
  const sf = parse(source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      DENIED_NAMES.has(node.text)
    ) {
      violations.push(
        `${RULE} ${source.file}:${String(lineOf(sf, node))} reads:${node.text}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

const probe = (name: string): SourceText => readSource(`${PROBES}/${name}`);

describe("billing units", () => {
  it("renders <Money> under src/features/billing only in the rate block and the invoices", () => {
    const files = listFiles(FEATURE_DIR).filter(
      (file) => file.endsWith(".tsx") && !isTestOnly(file),
    );
    expect(files).toContain("src/features/billing/bucket-meter.tsx");
    expect(files).toContain("src/features/billing/auto-topup.tsx");
    expect(
      files.flatMap((file) => moneyJsxViolations(readSource(file))),
    ).toEqual([]);
  });

  it("gives a Money to no billing view model but ContractRate and InvoicePage", () => {
    expect(viewModelViolations(readSource(CONTRACTS_FILE))).toEqual([]);
  });

  it("maps no credit balance and no token cost", () => {
    expect(mapperViolations(readSource(MAPPER_FILE))).toEqual([]);
  });

  it("fails a <Money> in the bucket meter or the auto top-up control", () => {
    expect(moneyJsxViolations(probe("bucket-meter.tsx"))).toEqual([
      `${RULE} ${PROBES}/bucket-meter.tsx:4 money-outside-rate-and-invoices`,
    ]);
    expect(moneyJsxViolations(probe("auto-topup.tsx"))).toEqual([
      `${RULE} ${PROBES}/auto-topup.tsx:5 money-outside-rate-and-invoices`,
    ]);
  });

  it("passes a <Money> in the rate block (negative)", () => {
    expect(moneyJsxViolations(probe("contract-rate.tsx"))).toEqual([]);
  });

  it("fails a view model other than the two that reaches Money through a local schema", () => {
    expect(viewModelViolations(probe("view-models.ts"))).toEqual([
      `${RULE} ${PROBES}/view-models.ts:10 money-in-view-model:GauBucket`,
    ]);
  });

  it("fails a mapper reading the credit balance or the token cost", () => {
    expect(mapperViolations(probe("mapper-credit-balance.ts"))).toEqual([
      `${RULE} ${PROBES}/mapper-credit-balance.ts:2 reads:costMicros`,
      `${RULE} ${PROBES}/mapper-credit-balance.ts:3 reads:creditBalanceCents`,
    ]);
  });

  it("passes a mapper reading ratePerGauMicros and amountDueMicros (negative)", () => {
    expect(mapperViolations(probe("mapper-rates.ts"))).toEqual([]);
  });
});
