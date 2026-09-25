"use server";
// The writes on an agent identity (#2956; ADR-057 decision 3) and on its
// definition file (ADR-057 decision 1), each through the kernel seam for the
// workspace viewer the URL names. Every contract here is `noBillingGate` and
// role-checked in its handler (INV-29): rotate, suspend and retire by an org
// Owner or Admin, commit by an Owner, Admin or Member; a refusal comes back as
// `denied` with nothing changed. request_mandate (#2957) joins them: an agent
// operator asks for authority and the accountable role decides. The roles
// block below is the third identity write (#2956): an org Owner or Admin
// attaches an IAM role to the agent's delegated principal, or detaches one.
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import { agentRoleList } from "@oxagen/oxagen/contracts/agent.role.list";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { mandateRequest } from "@oxagen/oxagen/contracts/mandate.request";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import {
  consequenceTagsOf,
  listOf,
  mandateLimitsOf,
} from "@/data/contracts/mandates";
import { getTranslations } from "next-intl/server";
import {
  AGENT_HARNESSES,
  type AgentHarness,
  draftAgentDefinition,
  isAgentSlug,
  MODEL_TIERS,
  type ModelTier,
} from "@/features/create";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer, viewerTimeZone } from "@/server/viewer";
import { endOfZonedDay, startOfZonedDay } from "@/shared/calendar-day";
import type { ActionFailure } from "./action-failure";

/** A refusal the action makes itself, before the kernel, naming the field at fault. */
function refuseField(field: string): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/** Retires the current key and mints a replacement; the secret is returned once and never again. */
export async function rotateAgentCredential(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ secret: string; expiresAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentCredentialRotate, { agentId });
  return result.ok
    ? {
        ok: true,
        value: {
          secret: result.value.credential.secret,
          expiresAt: result.value.credential.expiresAt,
        },
      }
    : result;
}

/** Suspends the agent, or resumes a suspended one when `suspended` is false. */
export async function setAgentSuspended(
  org: string,
  ws: string,
  agentId: string,
  suspended: boolean,
): Promise<ActionResult<{ status: "suspended" | "active" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentSuspend, { agentId, suspended });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** What the Register an agent dialog collects. */
export type RegisterDraft = { slug: string; harness: string; tier: string };

/**
 * Register an agent from the Agents list: opens the Context PR that adds
 * `.oxagen/agents/<slug>.toml` and the generated harness file beside it,
 * through propose_agent, and writes no Postgres row (agents.md, Register an
 * agent). The definition is the agent wizard's draft for a slug, a harness and
 * a model tier, so the two entry points write the same file; the wizard lets
 * the operator edit it first, this dialog does not. propose_agent runs its six
 * checks before anything reaches GitHub, and a failed check comes back as
 * `conflict` with `agent_check_<name>` and nothing written.
 */
export async function registerAgent(
  org: string,
  ws: string,
  draft: RegisterDraft,
): Promise<
  ActionResult<{ path: string; pullRequest: { number: number; url: string } }>
> {
  const slug = draft.slug.trim();
  if (!isAgentSlug(slug)) return refuseField("slug");
  const harness = AGENT_HARNESSES.find((h) => h === draft.harness);
  if (harness === undefined) return refuseField("harness");
  const tier = MODEL_TIERS.find((m) => m === draft.tier);
  if (tier === undefined) return refuseField("tier");
  const ctx = await requireViewer(org, ws);
  const t = await getTranslations("createAgent.definition.file");
  const source = draftAgentDefinition({
    slug,
    desc: "",
    tier: tier satisfies ModelTier,
    harness: harness satisfies AgentHarness,
    belt: [],
    copy: {
      header: t("header"),
      placeholder: t("placeholder"),
      stayInside: t("stayInside"),
    },
  });
  const result = await kernelWrite(ctx, agentPropose, {
    slug,
    harness,
    source,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          path: result.value.path,
          pullRequest: result.value.pullRequest,
        },
      }
    : result;
}

/** Retires the identity: its runs keep it, its credentials and host enrollments are revoked. */
export async function retireAgent(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ retiredAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRetire, { agentId });
  return result.ok
    ? { ok: true, value: { retiredAt: result.value.retiredAt } }
    : result;
}

/**
 * What the pause half of the kill switch answered, once the switch itself is
 * on. The two writes are not one transaction — `set_kill_switch` and
 * `dispatch_command` are separate contracts on separate stores — so a caller
 * that only checked `switchId` would believe every run stopped when the
 * broadcast half never ran.
 */
export type AgentPauseOutcome =
  /** A live run of this agent paused. */
  | { kind: "paused"; commandIds: string[] }
  /** The switch is on and every call is denied at the next boundary; no run was live to pause now. */
  | { kind: "no_live_runs" }
  /**
   * The agent carries no key (`org_ns.ws_ns.slug`, ADR-024), so `dispatch_command`
   * has nothing to address. The switch still stops every future tool call.
   */
  | { kind: "no_agent_key" }
  /** The switch flipped; the broadcast itself was refused or threw. */
  | { kind: "failed"; failure: ActionFailure };

/** The kill switch flip on an agent, and what it did to the agent's live runs. */
export type AgentKillSwitchOutcome = {
  switchId: string;
  /** False when the switch was already on and nothing changed. */
  changed: boolean;
  denyGeneration: { org: number; workspace: number };
  pause: AgentPauseOutcome;
};

/**
 * Stops one agent now: an emergency deny against every tool call it makes
 * (`kill_switch.ts`, ADR-072, #2958) and, in the same click, a pause queued
 * for every run of it still live (spec §7.6's agent broadcast).
 *
 * **The two are not redundant.** `set_kill_switch` denies at the *next call
 * boundary* through the deny generation (spec §6.11): a run mid-turn, between
 * calls, keeps running until it reaches one. `dispatch_command` reaches it
 * now, queued for the harness to take at its own next boundary. Flipping the
 * switch alone leaves an in-flight run's current turn to finish on its own;
 * broadcasting the pause alone leaves the agent free to start a new run the
 * moment this one stops. Both together is what "kill switch" means on this
 * page: nothing this agent starts is allowed, and nothing it has started
 * keeps going.
 *
 * The broadcast is skipped, not refused, when the identity carries no agent
 * key (`no_agent_key`): an unenrolled agent has never had a live run, and
 * `dispatch_command`'s agent target needs the key `list_runs` reports, not
 * the identity's public id. The switch write always runs first and its
 * result is never lost to a broadcast failure: `pause.kind: "failed"` still
 * reports `switchId` and `denyGeneration`, because the switch took effect
 * regardless of what the broadcast did.
 */
export async function pauseAgent(
  org: string,
  ws: string,
  agent: { agentId: string; agentKey: string | null },
  reason: string,
): Promise<ActionResult<AgentKillSwitchOutcome>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = reason.trim();
  const switchResult = await kernelWrite(ctx, killSwitchSet, {
    target: { kind: "agent", id: agent.agentId },
    on: true,
    reason: trimmed,
  });
  if (!switchResult.ok) return switchResult;

  const agentKey = agent.agentKey;
  const pause: AgentPauseOutcome =
    agentKey === null
      ? { kind: "no_agent_key" }
      : await (async () => {
          const dispatch = await kernelWrite(ctx, tachoCommandDispatch, {
            target: { kind: "agent", id: agentKey },
            command: "pause",
            reason: trimmed,
          });
          if (!dispatch.ok) return { kind: "failed", failure: dispatch };
          return dispatch.value.commandIds.length === 0
            ? { kind: "no_live_runs" }
            : { kind: "paused", commandIds: dispatch.value.commandIds };
        })();

  return {
    ok: true,
    value: {
      switchId: switchResult.value.switchId,
      changed: switchResult.value.changed,
      denyGeneration: switchResult.value.denyGeneration,
      pause,
    },
  };
}

// ── Roles ────────────────────────────────────────────────────────────────────
// assign_agent_role and revoke_agent_role name a role by NAME, not by id, so
// the dialog needs the catalogue to offer a choice. list_iam_roles answers it,
// and the read runs here rather than in a port: the Roles panel is server
// rendered from get_agent and the catalogue is wanted only once a person opens
// the dialog, so it is read on demand from an action exactly as the wizards'
// repository and toolbelt reads are (ARCHITECTURE.md §2, ADR-089).

/** One role the picker may offer: its name is what both writes take. */
type AssignableRole = {
  name: string;
  /** What the role is for, as the catalogue records it; null when it records nothing. */
  description: string | null;
  scope: "org" | "workspace";
  /** A seeded agent role rather than one this organization wrote. */
  builtIn: boolean;
};

/** The catalogue a role picker offers, and whether the kernel resolves grants yet. */
export type RoleOffer = {
  roles: AssignableRole[];
  /**
   * Whether the kernel's IAM check runs the resolver for this organization
   * (ARCHITECTURE.md §1.5). False means a role the agent holds governs nothing
   * until the organization moves to a tier that enforces it, and the dialog
   * says so rather than implying the assignment takes effect.
   */
  enforced: boolean;
  tier: string;
  /** More roles exist than the one page this read asks for. */
  more: boolean;
};

/**
 * The largest page `list_iam_roles` allows. One page is the whole catalogue
 * for every organization that has fewer than 200 roles, and a role past it is
 * a role the picker cannot offer, so the offer carries `more` and the dialog
 * says the list is partial rather than implying it is everything.
 */
const ROLE_PAGE = 200;

/**
 * The roles an agent may hold. `kind` is the contract's own answer to that
 * question: `agent` covers the seeded agent roles and every custom role, and
 * `human` covers the seeded membership roles, which `assign_agent_role`
 * refuses because the org Owner role is a resolver super-user and attaching it
 * to an unattended automation would be an escalation by construction.
 *
 * Filtering here means the picker cannot offer a choice the handler will
 * refuse. That matters more than it looks: the handler's refusal carries a
 * plain Error with `agent_role_not_assignable` in `code`, which the kernel seam
 * cannot classify, so the dialog would name it `kernel_failure` and the person
 * would learn nothing.
 *
 * Only an org Owner or Admin may read it. The catalogue names every role's
 * scope and the organization's enforcement tier, which only the people who
 * assign roles need. The picker is offered to those two roles alone. This
 * check holds the same line before the kernel call (#3525), and the
 * `list_iam_roles` handler asserts its contract's roles (Owner, Admin,
 * Compliance) on every surface as the gate that decides.
 */
export async function readAssignableRoles(
  org: string,
  ws: string,
): Promise<ActionResult<RoleOffer>> {
  const ctx = await requireViewer(org, ws);
  if (ctx.orgRole !== "owner" && ctx.orgRole !== "admin") {
    return { ok: false, reason: "denied", code: "org_role_required" };
  }
  const read = await kernelRead(ctx, {
    contract: iamRoleList,
    input: { includeGrants: false, limit: ROLE_PAGE, offset: 0 },
    page: "agents",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      roles: result.value.roles
        .filter((role) => role.kind === "agent")
        .map((role) => ({
          name: role.name,
          description: role.description,
          scope: role.scopeKind,
          builtIn: role.isSystemDefault,
        })),
      enforced: result.value.enforcement.enforced,
      tier: result.value.enforcement.tier,
      more: result.value.hasMore,
    },
  };
}

/**
 * The names of the roles the agent holds now (list_agent_roles: active,
 * unexpired assignments on its principal). Assign reads them to mark and
 * disable a role already held, as the design's picker does, and Deregister
 * reads them to count the roles retirement ends.
 */
export async function readAgentRoleNames(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<string[]>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: agentRoleList,
    input: { agentId },
    page: "agents",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  return {
    ok: true,
    value: [...new Set(result.value.roles.map((role) => role.roleName))],
  };
}

/**
 * Attaches the named role to the agent's delegated principal. The handler
 * refuses a role whose grants exceed the assigner's own (the delegation
 * ceiling), so an assignment can never widen what the person doing it holds.
 * `alreadyAssigned` comes back true when the agent held the role already, and
 * nothing was written. The reason, when the person gave one, rides the
 * capability's input into the audit event; a blank one is left out.
 */
export async function assignAgentRole(
  org: string,
  ws: string,
  agentId: string,
  roleName: string,
  reason = "",
): Promise<ActionResult<{ roleName: string; alreadyAssigned: boolean }>> {
  const name = roleName.trim();
  if (name === "") return refuseField("roleName");
  const why = reason.trim();
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRoleAssign, {
    agentId,
    roleName: name,
    ...(why === "" ? {} : { reason: why }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          roleName: result.value.roleName,
          alreadyAssigned: result.value.alreadyAssigned,
        },
      }
    : result;
}

/**
 * Detaches the named role. The row is soft-deleted, so the audit trail keeps
 * the assignment that was held. Idempotent: `revoked` is false when the agent
 * did not hold the role, which is what a second click on a stale page does.
 */
export async function revokeAgentRole(
  org: string,
  ws: string,
  agentId: string,
  roleName: string,
): Promise<ActionResult<{ roleName: string; revoked: boolean }>> {
  const name = roleName.trim();
  if (name === "") return refuseField("roleName");
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRoleRevoke, {
    agentId,
    roleName: name,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          roleName: result.value.roleName,
          revoked: result.value.revoked,
        },
      }
    : result;
}

// ── Cost center ──────────────────────────────────────────────────────────────
// The label this agent's spend is charged back to (ADR-142). `set_cost_center`
// names the agent by SLUG and takes only a label on the organization's live
// list, so the dialog offers that list rather than a text box, read on demand
// through `list_cost_centers` the way the role picker reads its catalogue. The
// handler admits an org Owner, Admin or Billing member; anyone else gets
// `denied` with nothing written.

/** One label the picker may offer. */
export type CostCenterChoice = { id: string; label: string };

/** The organization's live cost-center labels, by label. */
export async function readCostCenters(
  org: string,
  ws: string,
): Promise<ActionResult<CostCenterChoice[]>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: costCenterList,
    input: {},
    page: "agents",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value.costCenters.map((center) => ({
      id: center.id,
      label: center.label,
    })),
  };
}

/**
 * Charges the agent to `label`, or clears its label with the empty string so
 * it inherits the workspace's again. The handler stores the list's own
 * spelling and answers it. Runs rolled up after the write are charged to the
 * new label; runs already rolled up keep the label they had.
 */
export async function setAgentCostCenter(
  org: string,
  ws: string,
  agentSlug: string,
  label: string,
): Promise<ActionResult<{ costCenter: string | null }>> {
  const slug = agentSlug.trim();
  if (slug === "") return refuseField("agent");
  const ctx = await requireViewer(org, ws);
  const trimmed = label.trim();
  const result = await kernelWrite(ctx, costCenterSet, {
    target: "agent",
    agent: slug,
    costCenter: trimmed === "" ? null : trimmed,
  });
  return result.ok
    ? { ok: true, value: { costCenter: result.value.costCenter } }
    : result;
}

// ── Enrollment: the hosts an agent runs on ──────────────────────────────────
// Both writes are the Enrollment tab's (#2953). `revoke_tacho_enrollment` and
// `create_enrollment_token` are `noBillingGate` and admit an org Owner or
// Admin in their handlers, so a Member's click comes back `denied` with
// nothing written, named in the dialog.

/**
 * Revokes one host enrollment: its API key is soft-deleted, the row becomes
 * `revoked`, and a revoke command is queued so a collector mid-poll learns now
 * rather than at its next bundle refresh.
 *
 * The reason is recorded on the row and on the command. A blank box sends no
 * reason at all rather than an empty string, because the contract's input is
 * `.strict()` with `reason` optional and an empty string is a recorded reason
 * that says nothing.
 */
export async function revokeHostEnrollment(
  org: string,
  ws: string,
  hostEnrollmentId: string,
  reason: string,
): Promise<ActionResult<{ revokedAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = reason.trim();
  const result = await kernelWrite(ctx, tachoEnrollmentRevoke, {
    hostEnrollmentId,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { revokedAt: result.value.revokedAt } }
    : result;
}

/** A minted enrollment token. Shown once; a token that expires unused is replaced by minting another. */
export type EnrollmentToken = {
  token: string;
  expiresAt: string;
  /** `oxagen agent enroll --token …`, the scripted path (spec §14.1). */
  enrollCommand: string;
};

/**
 * Mints the single-use token a machine presents to `enroll_host` to become one
 * of this agent's hosts.
 *
 * The register flow mints the same token from `features/onboarding/actions.ts`
 * through the same contract and the same seam. The two are not one function
 * because a lane may not import another lane's internals (the eslint rule on
 * feature paths) and the onboarding barrel exports server components, which a
 * client component here must not pull into its bundle. What matters is that
 * neither mints differently: both call `create_enrollment_token` with the
 * agent id and show what it answered, and this one drops the `agentKey` the
 * register flow's SDK panel needs and the agent page does not.
 */
export async function issueAgentEnrollmentToken(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<EnrollmentToken>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, tachoEnrollmentTokenCreate, {
    agentId,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          token: result.value.token,
          expiresAt: result.value.expiresAt,
          enrollCommand: result.value.enrollCommand,
        },
      }
    : result;
}

export type DefinitionDraft = {
  agentId: string;
  branch: string;
  /** The commit and pull request title; blank leaves it to the handler. */
  message: string;
  source: string;
};

/** Commits the file to `branch` (never the default branch) and opens, or reuses, its pull request. */
export async function commitAgentDefinition(
  org: string,
  ws: string,
  draft: DefinitionDraft,
): Promise<
  ActionResult<{
    branch: string;
    commitSha: string;
    pullRequest: { number: number; url: string };
  }>
> {
  const ctx = await requireViewer(org, ws);
  const message = draft.message.trim();
  const result = await kernelWrite(ctx, agentDefinitionCommit, {
    agentId: draft.agentId,
    branch: draft.branch.trim(),
    source: draft.source,
    ...(message === "" ? {} : { message }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          branch: result.value.branch,
          commitSha: result.value.commitSha,
          pullRequest: result.value.pullRequest,
        },
      }
    : result;
}

/** The fields a mandate request carries, as the dialog collects them. */
export type MandateDraft = {
  agentId: string;
  /**
   * The consequences the mandate answers for, comma-separated. A mandate must
   * name **every** tag each covered tool declares or it authorizes none of
   * them (`findCoveringMandate`), so this is a set the operator states and not
   * a single choice — and not a closed one either: the starter six are a
   * starting point the workspace extends, and a tool declaring a tag of its
   * own must be nameable or it can never be given a mandate.
   */
  consequenceTags: string;
  /** The measure the tool version declares the limit under (`rows`, `recipients`). */
  measure: string;
  /**
   * What that measure counts, in its own name (`rows`, `recipients`). Never an
   * ISO 4217 code: this form writes counts and only counts, for the reason
   * `requestMandate` gives.
   */
  unit: string;
  /** The limits as typed, in whole units of `unit`. Nothing here is scaled. */
  perCall: string;
  perPeriod: string;
  period: "daily" | "weekly" | "monthly";
  /** An optional cap on the built-in `calls` measure, per day. */
  callsPerDay: string;
  /** Tool patterns over `slug@version`, comma-separated. */
  tools: string;
  purpose: string;
  /** Dates as the date inputs give them (`YYYY-MM-DD`). */
  validFrom: string;
  validTo: string;
};

/**
 * The day a date input gives. Deliberately narrower than the contract, which
 * takes an instant: the form collects days and widens each to the start and the
 * end of its own, so the window is inclusive at both ends. Every other bound
 * this action applies is a mirror of a contract rule and lives beside its rule
 * in `data/contracts/mandates.ts`.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function refuse(field: keyof MandateDraft): ActionResult<never> {
  return refuseField(field);
}

/**
 * Asks for a mandate on this agent's behalf. The handler records a draft for
 * the role accountable for the consequence to grant or decline; a draft grants
 * nothing, because the gate reads active mandates only.
 *
 * **This form never multiplies a limit.** A limit is stored in the units the
 * ledger records, and which those are is a property of the tool version's
 * declaration, not of the request: micros for an `amount`, whole units for a
 * `count` (INV-09). The gate reads the call by that declaration — `readMeasure`
 * in packages/rules/src/mandates/measures.ts converts an amount to micros and
 * takes a count as whole units — and compares it against the stored limit as
 * an integer.
 *
 * The declaration is not reachable from here, and nothing downstream catches a
 * request that disagrees with it. `measureDeclarationsSchema` is an input of
 * `publish_tool_declaration` and appears in no output; `list_tool_declarations`
 * answers the version and checksum and no `measures`; `get_agent_toolbelt`
 * carries none; and reading `agent.tool_versions` is banned (INV-05).
 * `assertToolsDeclareMeasures` (packages/handlers/src/_mandate.ts) refuses a
 * measure that is undeclared or `text` and never compares its `type` to
 * anything the request states, so a grant does not check the scaling either.
 *
 * Being wrong in the two directions is not symmetric, which is what decides
 * this:
 *
 *   scaled, declared a `count`   50 stored as 50000000, read as 50,000,000
 *                                counts — a millionfold MORE authority than
 *                                was typed, silently.
 *   verbatim, declared an `amount`  50 stored as "50", read as 50 micros — a
 *                                millionfold LESS. The call is denied and a
 *                                person sees it.
 *
 * Only the first is a silent over-grant, and a mandate is bounded authority: a
 * form that can store a wider bound than the operator entered is a worse
 * failure than a form that cannot express every bound. So the figure typed is
 * the figure stored, digit for digit. A money limit is correct only once the
 * declaration confirms the measure is an `amount`, so it is not requestable
 * here — it is requestable over the API and MCP, where the caller holds the
 * declaration, and the app reads one back as money either way.
 *
 * The durable fix is `measures` on `list_tool_declarations`' output: with it
 * the form resolves the declaration for the named measure across the tools its
 * patterns match, defaults from it, refuses a mismatch, and can scale an
 * amount because it knows it is one. That is `list_tool_declarations`' object
 * and not this lane's (ARCHITECTURE.md §9).
 */
export async function requestMandate(
  org: string,
  ws: string,
  draft: MandateDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  // `findCoveringMandate` (packages/rules/src/mandates.ts) accepts a mandate
  // only when `tool.consequenceTags.every(t => mandate.consequenceTags.includes(t))`,
  // so a mandate naming one tag of a tool that declares two covers nothing —
  // granted exactly as asked, and every call still denied, at the moment of use
  // and far from here. The form therefore writes the whole set the operator
  // names rather than a single tag. It cannot check the set against the tools:
  // `consequence_tags` lives on `agent.tool_versions` and appears in exactly
  // one contract, `publish_tool_declaration`, as an input — the same wall the
  // measure declaration is behind (INV-05). Naming too few is the safe way to
  // be wrong here, since the mandate then covers nothing rather than more than
  // was meant, and the gate's denial names the tags it wanted.
  const consequenceTags = consequenceTagsOf(draft.consequenceTags);
  if (consequenceTags === null) return refuse("consequenceTags");

  // Verbatim, no currency unit, never `calls`, and the measure optional beside
  // a calls cap: `mandateLimitsOf` holds the rule for both mandate forms, the
  // grant on the Tools ledger being the other, so they cannot drift apart.
  const limits = mandateLimitsOf(draft);
  if (!limits.ok) return refuse(limits.field);

  const tools = listOf(draft.tools);
  if (tools.length === 0) return refuse("tools");

  const purpose = draft.purpose.trim();
  if (purpose === "") return refuse("purpose");

  if (!DATE.test(draft.validFrom)) return refuse("validFrom");
  if (!DATE.test(draft.validTo)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  // The dates a person picks are days on their clock. Convert through the
  // saved zone so a Los Angeles Sep 20 starts at that local midnight and a
  // Tokyo validTo runs through that local day's last millisecond.
  //
  // The zone is read here, in the `"use server"` module that resolved the
  // viewer, and not down in `data/live` — a port implementation has no viewer
  // and no business asking who is looking (ARCHITECTURE.md §2). An on-demand
  // read from an action goes through the kernel seam exactly as its write does
  // (ADR-089), like the Repositories page's.
  //
  // A zone that cannot be established refuses; it does not fall back. The pages
  // do fall back to Pacific, because a date drawn in the wrong zone is a
  // cosmetic error a reader can see. A validity boundary written in the wrong
  // zone is not: for an operator in Tokyo, Pacific moves the end of their day 17
  // hours later, and nothing afterwards says the zone was guessed
  // (`server/viewer.ts` → `viewerTimeZone`).
  const zone = await viewerTimeZone(ctx, "agents");
  if (!zone.ok) return zone;
  const validFrom = startOfZonedDay(draft.validFrom, zone.timeZone);
  const validTo = endOfZonedDay(draft.validTo, zone.timeZone);
  if (validFrom === null) return refuse("validFrom");
  if (validTo === null) return refuse("validTo");
  if (Date.parse(validTo) <= Date.parse(validFrom)) return refuse("validTo");

  const result = await kernelWrite(ctx, mandateRequest, {
    agentId: draft.agentId,
    consequenceTags,
    limits: limits.limits,
    targets: {},
    tools,
    approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
    purpose,
    validFrom,
    validTo,
  });
  return result.ok
    ? {
        ok: true,
        value: { mandateId: result.value.id, status: result.value.status },
      }
    : result;
}
