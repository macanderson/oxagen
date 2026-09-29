// checks.ts: the checks a draft passes before it is stored or reviewed
// (lane M11, ADR-224).
//
// A saved test becomes one line of tests/calls.jsonl, which is committed to
// the steering repo. A credential in git history is hard to remove, so a test
// that carries one is refused, never scrubbed here. Studio strips credential
// headers before it stages a test (draft.ts, scrubTest), and this is the
// server's guard behind it.
import {
  HandlerError,
  type CapabilityContext,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import type { StudioDraftOp } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  CREDENTIAL_REQUEST_HEADERS,
  CREDENTIAL_RESPONSE_HEADERS,
  recordedCallSchema,
  recordedExchangeSchema,
  type FileIssue,
  type RecordedCall,
} from "@oxagen/mcp-studio";
import { contractRoleRequirement } from "../../lib/capability-role-guard";

type TestOp = Extract<StudioDraftOp, { kind: "test" }>;

/**
 * Refuse the call unless the acting person holds a role the contract grants,
 * and return who they are. A key acts as the person who created it.
 */
export async function authorizeStudio(
  contract: Pick<CapabilityDeclaration, "name" | "defaultRoles">,
  ctx: CapabilityContext,
): Promise<string | null> {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, contractRoleRequirement(contract));
  return userId;
}

/** Up to three issues as one sentence each, for a refusal's message. */
export function describeIssues(issues: readonly FileIssue[]): string {
  const shown = issues.slice(0, 3).map((issue) => {
    const at = [
      issue.line === null ? null : `line ${issue.line}`,
      issue.field === null ? null : issue.field,
    ]
      .filter((part) => part !== null)
      .join(", ");
    return at === "" ? `${issue.message}.` : `${at}: ${issue.message}.`;
  });
  const more = issues.length > 3 ? ` ${issues.length - 3} more issues follow.` : "";
  return `${shown.join(" ")}${more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The credential header `text` carries, lowercased, or null. */
function credentialHeader(text: string, refused: readonly string[]): string | null {
  const value = parsed(text);
  if (!value.ok || !isRecord(value.value) || !isRecord(value.value.headers)) return null;
  const names = new Set(refused);
  for (const name of Object.keys(value.value.headers)) {
    if (names.has(name.toLowerCase())) return name.toLowerCase();
  }
  return null;
}

/**
 * A header or query parameter name that reads like a credential. The three
 * fixed headers above are refused because a recorded call may never carry
 * them at all; this is the wider net, because a server may place its key in
 * `X-Api-Key` or in `?api_key=` and nothing about the draft says which. It
 * reads the name, not the value, so it cannot see a key under a harmless one:
 * that is why the published page states what this enforces rather than
 * promising a draft holds no credential whatever its shape.
 *
 * Deliberately not `key` anywhere in a name, which would refuse an ordinary
 * `Idempotency-Key`. Refusing a harmless name costs a person one edit, and a
 * key in the steering repo's history costs a rotation.
 */
const CREDENTIAL_NAME =
  /token|secret|passw|pwd|credential|session|signature|(?:^|[^a-z])(?:api|access|private|secret)[-_]?key(?:$|[^a-z])|^key$|^sig$|auth/i;

/**
 * The credential-shaped name in a recorded request's headers or query, or
 * null. The header names the three fixed ones already cover are left to them,
 * so each refusal says the more precise thing.
 */
function credentialShapedName(text: string, fixed: readonly string[]): string | null {
  const value = parsed(text);
  if (!value.ok || !isRecord(value.value)) return null;
  const skip = new Set(fixed);
  for (const field of ["headers", "query"] as const) {
    const part = value.value[field];
    if (!isRecord(part)) continue;
    for (const name of Object.keys(part)) {
      if (skip.has(name.toLowerCase())) continue;
      if (CREDENTIAL_NAME.test(name)) {
        return field === "headers"
          ? `the header ${name}`
          : `the query parameter ${name}`;
      }
    }
  }
  return null;
}

function testInvalid(op: TestOp, message: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "test_invalid",
    message: `The saved test of ${op.tool} cannot be recorded: ${message}`,
  });
}

/**
 * Refuse a saved test that holds a credential or does not make one recorded
 * exchange. Every test is checked before any is stored.
 */
export function checkTests(ops: readonly StudioDraftOp[]): void {
  for (const op of ops) {
    if (op.kind !== "test") continue;
    const header =
      credentialHeader(op.request, CREDENTIAL_REQUEST_HEADERS) ??
      credentialHeader(op.raw, CREDENTIAL_RESPONSE_HEADERS);
    if (header !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "test_holds_credential",
        message: `The saved test of ${op.tool} carries a ${header} header. A saved test holds no credential. Remove the header and save the test again.`,
      });
    }
    // A server's key may sit in any header or query parameter, so the name is
    // read too. The recorded request is what reaches tests/calls.jsonl.
    const shaped = credentialShapedName(op.request, CREDENTIAL_REQUEST_HEADERS);
    if (shaped !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "test_holds_credential",
        message: `The saved test of ${op.tool} carries ${shaped}, whose name reads like a credential. A saved test records the request as Studio built it, before the credential was added. Remove it and save the test again.`,
      });
    }
  }
  for (const op of ops) {
    if (op.kind === "test") exchangeOf(op);
  }
}

/** A saved test's arguments, exchange, and shaped result, checked. */
function exchangeOf(op: TestOp): Omit<RecordedCall, "tool" | "recorded_at"> {
  const args = parsed(op.args);
  if (!args.ok || !isRecord(args.value)) {
    throw testInvalid(op, "its arguments are not a JSON object.");
  }
  const request = parsed(op.request);
  const response = parsed(op.raw);
  if (!request.ok || !response.ok) {
    throw testInvalid(op, "its request and its raw result must each be JSON.");
  }
  const exchange = recordedExchangeSchema.safeParse({
    request: request.value,
    response: response.value,
  });
  if (!exchange.success) {
    throw testInvalid(op, "its request and raw result do not make one recorded exchange.");
  }
  const result = parsed(op.shaped);
  if (!result.ok) {
    throw testInvalid(op, "its shaped result is not JSON.");
  }
  return {
    arguments: args.value,
    exchanges: [exchange.data],
    result: result.value as RecordedCall["result"],
  };
}

/** One line of tests/calls.jsonl for a saved test of the tool keyed `key`. */
export function recordedCall(op: TestOp, key: string): RecordedCall {
  const call = recordedCallSchema.safeParse({ tool: key, ...exchangeOf(op) });
  if (!call.success) {
    throw testInvalid(op, "it does not fit tests/calls.jsonl.");
  }
  return call.data;
}
