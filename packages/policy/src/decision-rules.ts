/**
 * Converts a workspace's decision rules, `workspaces.settings.decisionRules`,
 * to Cedar policies for the steering repo. This is the migration path from
 * the old rule evaluator (`evaluateRules` in `@oxagen/rules`) to Cedar
 * (lane S12).
 *
 * The old evaluator takes the first rule that matches, in priority order,
 * highest first and then by id. Cedar has no order. Every forbid that matches
 * denies. So each converted rule carries an `unless` guard for every earlier
 * rule that governs one of its tools, and a call an earlier rule decided
 * never reaches a later one. A deny rule becomes a `forbid`. A
 * require_approval rule becomes a `forbid` marked
 * `@decision("require_approval")`, which a granted approval lifts. An allow
 * rule writes no policy. It lives in the guards of the rules after it, and
 * `converted` lists it with the rest.
 *
 * A rule governs the imported tools whose identity, `mcp.<server>.<tool>`,
 * its capability matches. Cedar reads a call's arguments, so a condition
 * converts only on `input.<name>`. A rule is left in `unconverted`, with the
 * reason, when it governs no imported tool, reads `facts.*`, `call.*`, or a
 * nested argument, or follows an unconverted rule over the same tools.
 *
 * Two behaviors change. An argument of the wrong type, such as an amount sent
 * as a string, now denies the call (`typedArgs` in `@oxagen/recorder/policy`).
 * The old evaluator only failed to match the condition. An argument sent as
 * null now reads as absent, so `exists`, `neq`, and `not_in` no longer match
 * it.
 */
import type { CedarToolEntry } from "@oxagen/recorder";
import { APPROVAL_ANNOTATION, APPROVAL_VALUE, type CedarArgType } from "@oxagen/recorder/policy";
import { cedarString, isCedarIdentifier } from "./schema";

/** A condition operator, as `@oxagen/rules` names it. */
export type ConditionOpLike =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "exists";

/** One test on one fact. */
export interface ConditionLeafLike {
  fact: string;
  op: ConditionOpLike;
  value?: unknown;
}

/** An empty `all` is true and an empty `any` is false. */
export type ConditionLike =
  | { all: readonly ConditionLike[] }
  | { any: readonly ConditionLike[] }
  | { not: ConditionLike }
  | ConditionLeafLike;

/**
 * A decision rule in the fields the converter reads. It mirrors
 * `DecisionRule` in `@oxagen/rules`, so this package does not depend on that
 * one.
 */
export interface DecisionRuleLike {
  id: string;
  description: string;
  capability: string;
  priority?: number;
  when?: ConditionLike;
  effect: "allow" | "deny" | "require_approval";
}

export interface ConvertedRules {
  /** The policies as one Cedar file, in first-match order. */
  text: string;
  /** Each policy by its id, `rules.<rule id>`, as the signed bundle carries it. */
  policies: Record<string, string>;
  /** The ids of the policies a granted approval lifts. */
  approval_ids: string[];
  /** The rules the text carries, in first-match order. */
  converted: string[];
  /** The rules the text leaves out, in first-match order, each with the reason. */
  unconverted: { id: string; reason: string }[];
}

type Tools = Readonly<Record<string, CedarToolEntry>>;

/** The argument types of each tool a rule governs. */
type ArgMaps = readonly Readonly<Record<string, CedarArgType>>[];

type Expr = { ok: true; text: string } | { ok: false; reason: string };

function ok(text: string): Expr {
  return { ok: true, text };
}

function fail(reason: string): Expr {
  return { ok: false, reason };
}

const HEADER = `// Converted by Oxagen from the workspace's decision rules. Each policy's id
// is rules.<rule id>. An allow rule writes no policy. It is the unless guard
// in each later rule it would have decided first.`;

const EXTERNAL_IDENTITY = /^(?:mcp|file-mcp)\./i;

/** `canonicalToolIdentity` in `@oxagen/rules`: an external tool's case is not part of its name. */
function canonical(name: string): string {
  return EXTERNAL_IDENTITY.test(name) ? name.toLowerCase() : name;
}

/**
 * Whether a capability governs an imported tool, matched as
 * `capabilityMatches` in `@oxagen/rules` matches it. The tool's identity is
 * its action id `<server>__<tool>` read as `mcp.<server>.<tool>`.
 */
function governs(capability: string, action: string): boolean {
  if (capability === "*") return true;
  const glob = canonical(capability);
  const identity = `mcp.${action.replace("__", ".")}`.toLowerCase();
  return glob.endsWith("*") ? identity.startsWith(glob.slice(0, -1)) : glob === identity;
}

/** First-match order: priority, highest first, then id, bytewise. */
function ordered(rules: readonly DecisionRuleLike[]): DecisionRuleLike[] {
  return [...rules].sort((a, b) => {
    const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isLong(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A value as a Cedar literal of the argument's type. A set argument never equals a value. */
function literal(value: unknown, type: CedarArgType): string | undefined {
  if (type === "String") return typeof value === "string" ? cedarString(value) : undefined;
  if (type === "Long") return isLong(value) ? String(value) : undefined;
  if (type === "Bool") return typeof value === "boolean" ? String(value) : undefined;
  return undefined;
}

/** Text a `like` pattern matches literally: a Cedar string's body, with `*` escaped. */
function likeText(text: string): string {
  return cedarString(text).slice(1, -1).replaceAll("*", "\\*");
}

/** The `has` test and the read of one argument, quoted where Cedar needs it. */
function argAccess(name: string): { has: string; ref: string } {
  if (isCedarIdentifier(name)) {
    return { has: `context.args has ${name}`, ref: `context.args.${name}` };
  }
  const quoted = cedarString(name);
  return { has: `context.args has ${quoted}`, ref: `context.args[${quoted}]` };
}

/** The one Cedar type the governed tools give an argument. */
function argType(name: string, argMaps: ArgMaps): { type: CedarArgType } | { reason: string } {
  const types = new Set<CedarArgType>();
  for (const args of argMaps) {
    // `hasOwn` keeps a name such as `constructor` off the prototype.
    const type = Object.hasOwn(args, name) ? args[name] : undefined;
    if (type !== undefined) types.add(type);
  }
  const found = [...types];
  const type = found[0];
  if (type === undefined) {
    return {
      reason: `Cedar cannot read input.${name}. No tool the rule governs declares it with a type Cedar holds.`,
    };
  }
  if (found.length > 1) return { reason: `The tools the rule governs type input.${name} differently.` };
  return { type };
}

const COMPARISON = { lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/**
 * One leaf as Cedar. A leaf that reads the argument tests it with `has`
 * first, so a missing argument fails the leaf as it did before, and `not`
 * over it holds.
 */
function leaf(test: ConditionLeafLike, argMaps: ArgMaps): Expr {
  const { fact, op, value } = test;
  const name = fact.startsWith("input.") ? fact.slice("input.".length) : undefined;
  if (name === undefined || name.includes(".")) {
    return fail(`Cedar reads a tool argument as input.<name>, so it cannot read ${fact}.`);
  }
  const resolved = argType(name, argMaps);
  if ("reason" in resolved) return fail(resolved.reason);
  const { type } = resolved;
  const { has, ref } = argAccess(name);
  const guarded = (text: string): Expr => ok(`${has} && ${text}`);

  switch (op) {
    case "exists":
      return ok(has);
    case "eq": {
      const lit = literal(value, type);
      return lit === undefined ? ok("false") : guarded(`${ref} == ${lit}`);
    }
    case "neq": {
      const lit = literal(value, type);
      return lit === undefined ? ok(has) : guarded(`${ref} != ${lit}`);
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (type !== "Long" || typeof value !== "number" || !Number.isFinite(value)) return ok("false");
      // A whole number is below 10.5 exactly when it is below 11.
      const bound = op === "lt" || op === "gte" ? Math.ceil(value) : Math.floor(value);
      if (!Number.isSafeInteger(bound)) {
        return fail(`The bound in ${fact} ${op} ${value} is outside the whole numbers Cedar reads.`);
      }
      return guarded(`${ref} ${COMPARISON[op]} ${bound}`);
    }
    case "in":
    case "not_in": {
      if (!Array.isArray(value)) return ok("false");
      const members = [
        ...new Set(
          value.map((v: unknown) => literal(v, type)).filter((v): v is string => v !== undefined),
        ),
      ];
      const set = `[${members.join(", ")}]`;
      if (op === "in") return members.length === 0 ? ok("false") : guarded(`${set}.contains(${ref})`);
      return members.length === 0 ? ok(has) : guarded(`!${set}.contains(${ref})`);
    }
    case "contains":
      if (type === "String" && typeof value === "string") {
        return guarded(`${ref} like "*${likeText(value)}*"`);
      }
      if (type === "Set<String>" && typeof value === "string") {
        return guarded(`${ref}.contains(${cedarString(value)})`);
      }
      if (type === "Set<Long>" && isLong(value)) return guarded(`${ref}.contains(${value})`);
      return ok("false");
    case "starts_with":
      return type === "String" && typeof value === "string"
        ? guarded(`${ref} like "${likeText(value)}*"`)
        : ok("false");
    default:
      return fail(`Cedar has no form for the ${String(op)} operator.`);
  }
}

function joined(
  parts: readonly ConditionLike[],
  operator: string,
  empty: string,
  argMaps: ArgMaps,
): Expr {
  if (parts.length === 0) return ok(empty);
  const texts: string[] = [];
  for (const part of parts) {
    const expr = condition(part, argMaps);
    if (!expr.ok) return expr;
    texts.push(`(${expr.text})`);
  }
  return ok(texts.join(operator));
}

function condition(when: ConditionLike, argMaps: ArgMaps): Expr {
  if ("all" in when) return joined(when.all, " && ", "true", argMaps);
  if ("any" in when) return joined(when.any, " || ", "false", argMaps);
  if ("not" in when) {
    const inner = condition(when.not, argMaps);
    return inner.ok ? ok(`!(${inner.text})`) : inner;
  }
  return leaf(when, argMaps);
}

function actionSet(actions: readonly string[]): string {
  return `[${actions.map((a) => `Action::${cedarString(a)}`).join(", ")}]`;
}

/** A description on one line, since a Cedar comment ends at the line break. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function policyText(
  rule: DecisionRuleLike,
  id: string,
  actions: readonly string[],
  when: string | undefined,
  guards: readonly string[],
): string {
  const approval = rule.effect === "require_approval";
  const lines = [`// ${oneLine(rule.description)}`.trimEnd(), `@id(${cedarString(id)})`];
  if (approval) lines.push(`@${APPROVAL_ANNOTATION}(${cedarString(APPROVAL_VALUE)})`);
  lines.push("forbid (", "  principal,", `  action in ${actionSet(actions)},`, "  resource", ")");
  if (when !== undefined) lines.push(`when { ${when} }`);
  if (approval) lines.push("unless { context.approval.granted }");
  if (guards.length > 0) lines.push(`unless { ${guards.join(" || ")} }`);
  return `${lines.join("\n")};`;
}

/**
 * The workspace's decision rules as Cedar policies over its imported tools,
 * keyed by action id as the signed bundle carries them.
 */
export function convertDecisionRules(input: {
  rules: readonly DecisionRuleLike[];
  tools: Tools;
}): ConvertedRules {
  const { tools } = input;
  const actionIds = Object.keys(tools).sort();
  // The converted rules so far, allow rules included, for the guards after them.
  const earlier: { actions: ReadonlySet<string>; when: string | undefined }[] = [];
  // The unconverted rules that govern a tool. A later rule over one of those
  // tools cannot convert, since Cedar cannot tell whether the earlier rule
  // would have decided the call first.
  const blocked: { id: string; actions: ReadonlySet<string> }[] = [];
  const chunks: string[] = [];
  const policies: Record<string, string> = {};
  const approvalIds: string[] = [];
  const converted: string[] = [];
  const unconverted: { id: string; reason: string }[] = [];

  for (const rule of ordered(input.rules)) {
    const actions = actionIds.filter((a) => governs(rule.capability, a));
    if (actions.length === 0) {
      unconverted.push({ id: rule.id, reason: "It governs no imported tool." });
      continue;
    }
    const covered = new Set(actions);
    const blocker = blocked.find((b) => actions.some((a) => b.actions.has(a)));
    if (blocker !== undefined) {
      unconverted.push({
        id: rule.id,
        reason: `It follows ${blocker.id}, which governs the same tools and did not convert.`,
      });
      blocked.push({ id: rule.id, actions: covered });
      continue;
    }
    let when: string | undefined;
    if (rule.when !== undefined) {
      const argMaps = Object.entries(tools)
        .filter(([action]) => covered.has(action))
        .map(([, tool]) => tool.args);
      const expr = condition(rule.when, argMaps);
      if (!expr.ok) {
        unconverted.push({ id: rule.id, reason: expr.reason });
        blocked.push({ id: rule.id, actions: covered });
        continue;
      }
      when = expr.text;
    }

    const guards: string[] = [];
    for (const prior of earlier) {
      const shared = actions.filter((a) => prior.actions.has(a));
      if (shared.length === 0) continue;
      const scope = `action in ${actionSet(shared)}`;
      guards.push(prior.when === undefined ? scope : `(${scope} && (${prior.when}))`);
    }
    earlier.push({ actions: covered, when });
    converted.push(rule.id);
    if (rule.effect === "allow") continue;

    const id = `rules.${rule.id}`;
    const text = policyText(rule, id, actions, when, guards);
    chunks.push(text);
    policies[id] = text;
    if (rule.effect === "require_approval") approvalIds.push(id);
  }

  return {
    text: `${[HEADER, ...chunks].join("\n\n")}\n`,
    policies,
    approval_ids: approvalIds,
    converted,
    unconverted,
  };
}
