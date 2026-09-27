/**
 * Compiles one workspace's policy set on publish (lane S12).
 *
 * The set holds three parts. The grant permits every agent in the workspace
 * each tool the workspace imported, and the built-in tools its harness can
 * reach. The steering repo's rules in `policy/*.cedar` narrow the grant.
 * The schema from `writeCedarSchema` checks both in strict mode, so a
 * misspelled context path or an optional argument read without `has` stops
 * the publish instead of reaching a host.
 *
 * Nobody writes the grant as a rule. A permit written again as a rule would
 * outlive the import it restates (agent policy spec, Patterns to avoid).
 *
 * The caller merges the organization's policy files into each workspace's
 * compile, so one organization rule reaches every workspace.
 */
import {
  cedarPrincipalSchema,
  type CedarBundle,
  type CedarPrincipalEntry,
  type CedarToolEntry,
} from "@oxagen/tacho";
import {
  APPROVAL_ANNOTATION,
  APPROVAL_VALUE,
  harnessBuiltinActions,
  type CedarRuntime,
} from "@oxagen/tacho/policy";
import { cedarString, writeCedarSchema } from "./schema";

/** One file under `policy/` in the steering repo. */
export interface PolicyFile {
  /** The path in the steering repo, such as `policy/money.cedar`. */
  path: string;
  text: string;
}

/** One agent from `agents/<name>.toml`, and the facts its requests read. */
export interface AgentDeclaration {
  name: string;
  operator: string;
  runtime: string;
  harness: string;
  operator_role?: string;
  budget_remaining_cents?: number;
}

export interface CompileInput {
  /** The workspace's id, which each agent's `Workspace` entity carries. */
  workspace: string;
  policies: readonly PolicyFile[];
  agents: readonly AgentDeclaration[];
  /** Each imported tool by its action id, from `cedarTools`. */
  tools: Readonly<Record<string, CedarToolEntry>>;
}

/** Why a policy set did not compile, or what to look at in one that did. */
export interface CompileProblem {
  path?: string;
  policy_id?: string;
  message: string;
}

/**
 * The workspace's compiled policy set: what the gateway decides with, and
 * what each host's signed bundle carries a slice of (`hostCedarBundle`).
 */
export interface CompiledPolicySet {
  cedar_version: string;
  /** Every policy by id: the grant, then the steering repo's rules. */
  policies: Record<string, string>;
  /** The ids of the forbids marked `@decision("require_approval")`, sorted. */
  approval_ids: string[];
  /** The text of `policy/schema.cedarschema`. */
  schema: string;
  /** Every agent in the workspace. */
  principals: CedarPrincipalEntry[];
  tools: Record<string, CedarToolEntry>;
}

export interface CompileResult {
  /** Absent when any error stops the publish. */
  policy_set?: CompiledPolicySet;
  /** The schema, written whether or not the set compiled. */
  schema: string;
  errors: CompileProblem[];
  warnings: CompileProblem[];
}

/** The id prefix the compiled grant uses. A rule may not claim it. */
export const GRANT_PREFIX = "grant.";

/** The largest policy text the signed bundle carries. */
export const MAX_POLICY_TEXT = 65_536;
/** The most policies the signed bundle carries. */
export const MAX_POLICIES = 2048;
/** The most tools the signed bundle carries. */
export const MAX_TOOLS = 4096;
/** Where the tool grant splits into another policy, below `MAX_POLICY_TEXT`. */
const GRANT_CHUNK = 60_000;

interface ParsedPolicy {
  id: string;
  path: string;
  /** The policy's place in its file, from 1. */
  position: number;
  text: string;
  approval: boolean;
}

/**
 * Cedar's automatic ids, `policy0` to `policy<n-1>`, in the order
 * `policySetTextToParts` returns them: sorted as strings, so `policy10`
 * comes before `policy2`. Each entry is the source position of that part.
 */
function lexicalOrder(count: number): number[] {
  return Array.from({ length: count }, (_, k) => `policy${k}`)
    .sort()
    .map((id) => Number(id.slice("policy".length)));
}

/**
 * The source position of each part. A part is the policy's own text, so its
 * offset in the file orders it. Where two parts cannot be told apart by
 * offset, Cedar's id order does.
 */
function sourceOrder(source: string, parts: readonly string[]): number[] {
  const offsets = parts.map((part) => source.indexOf(part));
  const distinct = new Set(offsets);
  if (!offsets.includes(-1) && distinct.size === parts.length) {
    const ranked = [...offsets].sort((a, b) => a - b);
    return offsets.map((offset) => ranked.indexOf(offset));
  }
  return lexicalOrder(parts.length);
}

function parsePolicyFile(
  runtime: CedarRuntime,
  file: PolicyFile,
  errors: CompileProblem[],
): ParsedPolicy[] {
  const split = runtime.policySetTextToParts(file.text);
  if (split.type === "failure") {
    for (const e of split.errors) errors.push({ path: file.path, message: e.message });
    return [];
  }
  if (split.policy_templates.length > 0) {
    errors.push({
      path: file.path,
      message: "A policy template has no place in the steering repo. Write each rule as a policy.",
    });
  }
  const order = sourceOrder(file.text, split.policies);
  const parsed: ParsedPolicy[] = [];
  split.policies.forEach((text, i) => {
    const position = (order[i] ?? i) + 1;
    const json = runtime.policyToJson(text);
    if (json.type === "failure") {
      for (const e of json.errors) errors.push({ path: file.path, message: e.message });
      return;
    }
    const annotations = json.json.annotations ?? {};
    const id = annotations["id"] ?? `${file.path}#${position}`;
    const decision = annotations[APPROVAL_ANNOTATION];
    if (decision !== undefined && decision !== APPROVAL_VALUE) {
      errors.push({
        path: file.path,
        policy_id: id,
        message: `@decision takes one value, "${APPROVAL_VALUE}".`,
      });
    }
    const approval = decision === APPROVAL_VALUE;
    if (approval && json.json.effect !== "forbid") {
      errors.push({
        path: file.path,
        policy_id: id,
        message: '@decision("require_approval") marks a forbid. A permit cannot park a call.',
      });
    }
    if (text.length > MAX_POLICY_TEXT) {
      errors.push({
        path: file.path,
        policy_id: id,
        message: `The policy is ${text.length} characters. The limit is ${MAX_POLICY_TEXT}.`,
      });
    }
    parsed.push({ id, path: file.path, position, text, approval });
  });
  return parsed.sort((a, b) => a.position - b.position);
}

function entityRef(type: "Workspace" | "Action" | "Agent", id: string): string {
  return `${type}::${cedarString(id)}`;
}

/**
 * The grant. `grant.tools.<n>` permits every agent in the workspace each
 * imported tool, split so no policy passes the size limit.
 * `grant.builtin.<harness>` permits each agent the built-in actions its
 * harness reaches, `builtin__shell` among them.
 */
export function grantPolicies(
  workspace: string,
  tools: readonly string[],
  harnesses: readonly string[],
): Record<string, string> {
  const principal = `principal in ${entityRef("Workspace", workspace)}`;
  const grants: Record<string, string> = {};
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const action of [...tools].sort()) {
    const ref = entityRef("Action", action);
    if (chunk.length > 0 && size + ref.length + 2 > GRANT_CHUNK) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(ref);
    size += ref.length + 2;
  }
  if (chunk.length > 0) chunks.push(chunk);
  chunks.forEach((refs, i) => {
    const id = `${GRANT_PREFIX}tools.${i + 1}`;
    grants[id] = `@id(${cedarString(id)})\npermit (\n  ${principal},\n  action in [${refs.join(", ")}],\n  resource\n);`;
  });
  for (const harness of [...new Set(harnesses)].sort()) {
    const id = `${GRANT_PREFIX}builtin.${harness}`;
    const refs = harnessBuiltinActions(harness).map((a) => entityRef("Action", a));
    grants[id] = `@id(${cedarString(id)})\npermit (\n  ${principal},\n  action in [${refs.join(", ")}],\n  resource\n)\nwhen { principal.harness == ${cedarString(harness)} };`;
  }
  return grants;
}

function principalsOf(input: CompileInput, errors: CompileProblem[]): CedarPrincipalEntry[] {
  const seen = new Set<string>();
  const principals: CedarPrincipalEntry[] = [];
  for (const agent of input.agents) {
    const parsed = cedarPrincipalSchema.safeParse({ ...agent, workspace: input.workspace });
    if (!parsed.success) {
      errors.push({
        path: `agents/${agent.name}.toml`,
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" "),
      });
      continue;
    }
    if (seen.has(agent.name)) {
      errors.push({ path: `agents/${agent.name}.toml`, message: `Two agents are named ${agent.name}.` });
      continue;
    }
    seen.add(agent.name);
    principals.push(parsed.data);
  }
  return principals;
}

/**
 * Compiles the workspace's policy set and checks it against the schema in
 * strict mode. Any error leaves `policy_set` absent, and the publish stops.
 */
export function compilePolicies(input: CompileInput, runtime: CedarRuntime): CompileResult {
  const errors: CompileProblem[] = [];
  const warnings: CompileProblem[] = [];
  const schema = writeCedarSchema(input.tools);
  const principals = principalsOf(input, errors);
  const toolIds = Object.keys(input.tools);
  if (toolIds.length > MAX_TOOLS) {
    errors.push({ message: `The workspace imports ${toolIds.length} tools. The limit is ${MAX_TOOLS}.` });
  }

  const policies = grantPolicies(
    input.workspace,
    toolIds,
    principals.map((p) => p.harness),
  );
  const paths = new Map<string, string>();
  const approvalIds: string[] = [];
  for (const file of input.policies) {
    for (const policy of parsePolicyFile(runtime, file, errors)) {
      if (policy.id.startsWith(GRANT_PREFIX)) {
        errors.push({
          path: policy.path,
          policy_id: policy.id,
          message: `Ids that start with "${GRANT_PREFIX}" belong to the compiled grant. Choose another id.`,
        });
        continue;
      }
      const other = paths.get(policy.id);
      if (other !== undefined) {
        errors.push({
          path: policy.path,
          policy_id: policy.id,
          message: `The id ${policy.id} is already used in ${other}.`,
        });
        continue;
      }
      paths.set(policy.id, policy.path);
      policies[policy.id] = policy.text;
      if (policy.approval) approvalIds.push(policy.id);
    }
  }
  const count = Object.keys(policies).length;
  if (count > MAX_POLICIES) {
    errors.push({ message: `The set holds ${count} policies. The limit is ${MAX_POLICIES}.` });
  }

  const validation = runtime.validate({
    validationSettings: { mode: "strict" },
    schema,
    policies: { staticPolicies: policies },
  });
  if (validation.type === "failure") {
    for (const e of validation.errors) errors.push({ message: e.message });
  } else {
    const problem = (e: { policyId: string; error: { message: string } }): CompileProblem => {
      const path = paths.get(e.policyId);
      return {
        ...(path !== undefined ? { path } : {}),
        policy_id: e.policyId,
        message: e.error.message,
      };
    };
    errors.push(...validation.validationErrors.map(problem));
    warnings.push(...validation.validationWarnings.map(problem));
    warnings.push(...validation.otherWarnings.map((e) => ({ message: e.message })));
  }

  if (errors.length > 0) return { schema, errors, warnings };
  return {
    policy_set: {
      cedar_version: runtime.getCedarVersion(),
      policies,
      approval_ids: approvalIds.sort(),
      schema,
      principals,
      tools: { ...input.tools },
    },
    schema,
    errors,
    warnings,
  };
}

/**
 * The Cedar part of one host's signed bundle: the compiled set with only
 * the agents whose runtime is this host. Absent when no agent runs there.
 */
export function hostCedarBundle(set: CompiledPolicySet, runtime: string): CedarBundle | undefined {
  const principals = set.principals.filter((p) => p.runtime === runtime);
  if (principals.length === 0) return undefined;
  return {
    cedar_version: set.cedar_version,
    policies: { ...set.policies },
    approval_ids: [...set.approval_ids],
    schema: set.schema,
    principals: principals.map((p) => ({ ...p })),
    tools: set.tools,
  };
}
