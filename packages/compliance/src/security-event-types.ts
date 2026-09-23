// security-event-types.ts — THE single source of truth for the SOC2 audit
// event taxonomy.
//
// `@oxagen/database` and `@oxagen/telemetry` both import the types from here,
// and the DB CHECK clause is generated programmatically from this array (see
// db-check.ts). Adding a new event type is one edit, in this file. The drift
// tests in @oxagen/compliance and @oxagen/database fail if the migration
// falls out of sync with this list.
//
// RULES (do not relax):
//   - Group values by domain (auth / api_key / billing / capability / org / plugin);
//     within a group, order by lifecycle, not alphabetically.
//   - Never remove a value that has ever shipped — audit rows referencing it
//     must remain readable. Deprecate in comments instead.
//   - Names are `<domain>.<event>`; outcomes live in SECURITY_OUTCOMES, not here.
//
// DECLARED ≠ EMITTED. A value in this list only reserves a name and widens the
// DB CHECK; it does not mean any code path produces that row. Values with no
// emitter anywhere in the repo are marked `RESERVED — no emitter` below. Do not
// cite a RESERVED type as auditor evidence: querying it returns zero rows.
//
// Those RESERVED markers are HAND-MAINTAINED — no test asserts that an unmarked
// value has a live emitter, so a type can lose its last emitter and keep reading
// as covered. Re-verify by grepping the repo for the literal before relying on
// one as evidence.

// ---------------------------------------------------------------------------
// SECURITY_EVENT_TYPES — typed const-union.
// ---------------------------------------------------------------------------

export const SECURITY_EVENT_TYPES = [
  // Auth lifecycle
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.sign_out",
  // RESERVED — no emitter. Better Auth hooks in packages/auth/src/auth.ts emit
  // only sign_in and sign_out; nothing writes these three.
  "auth.token_refreshed",
  "auth.password_changed",
  "auth.email_verified",
  // API key lifecycle
  "api_key.created",
  "api_key.revoked",
  "api_key.used",
  // Billing mutations
  "billing.access_denied",
  "billing.auto_reload_updated",
  "billing.checkout_initiated",
  "billing.credits_purchased",
  "billing.payment_method_added",
  "billing.payment_method_default_changed",
  "billing.payment_method_removed",
  "billing.plan_changed",
  "billing.seats_changed",
  "billing.subscription_canceled",
  "billing.subscription_reactivated",
  // Spend-ceiling mutation (set_spend_budget): how much may be spent per
  // period, per scope. Distinct from auto_reload_updated (when to top up).
  "billing.budget_updated",
  // Capability authz
  "capability.invoke_allowed",
  "capability.invoke_denied",
  "capability.invoke_error",
  // Org lifecycle
  "organization.created",
  "workspace.created",
  // Archiving a workspace freezes it: it leaves the lists and its slug stays
  // taken (issue #2964). Emitted by the archive_workspace handler
  // (packages/handlers/src/workspace.archive.ts).
  "workspace.archived",
  // Admin / org management
  "org.member_invited",
  "org.member_removed",
  "org.role_changed",
  // Role definitions (ADR-063). Creating a role, replacing its grants and
  // deleting it change what every holder may ask for (SOC2 CC6.1). Emitted by
  // the create_role, set_role_grants and delete_role handlers
  // (packages/handlers/src/iam.role.{create,grants.set,delete}.ts);
  // `org.role_changed` above stays the membership event.
  "iam.role_created",
  "iam.role_grants_set",
  "iam.role_deleted",
  // Plugin governance (org-level marketplace administration)
  "plugin.installed",
  "plugin.uninstalled",
  "plugin.enabled_changed",
  // RESERVED — no emitter. There is no org plugin denylist: the entitlement
  // service explicitly has "no pre-approval / denylist"
  // (packages/plugins/src/entitlements/entitlement-service.ts).
  "plugin.denylist_added",
  "plugin.denylist_removed",
  // Plugin credential lifecycle (oxagen#2533). Storing or deleting a plugin's
  // OAuth token or secret is a privileged credential change (SOC2 CC6.1). Both
  // handlers used to carry an audit-exempt comment saying no fitting type
  // existed, which was true and is why these are here.
  "plugin.credential_set",
  "plugin.credential_revoked",
  // Secret lifecycle (oxagen#2527). Reveal and export are reads, and they are
  // in this list because reading a secret in the clear is the privileged act an
  // audit trail exists to catch — the other two mutate. All four also write
  // environments.secret_access_log, which is a richer per-secret record; these
  // rows are what make the same access visible to anyone querying the main
  // audit log. ADR-050 says why both, rather than one or the other.
  "secret.revealed",
  "secret.exported",
  "secret.value_changed",
  "secret.key_deleted",
  // Security policy
  "security.mfa_policy_updated",
  "security.session_revoked",
  // Organisation-scoped data planes (ADR-042). Binding an organisation's
  // store to a customer-controlled endpoint — or flipping one's mode, status,
  // or credentials — moves where that tenant's traces, graph, and evidence
  // physically live. That is the archetypal privileged configuration change a
  // SOC2 CC6.1/CC6.8 auditor asks for by name, and it is emitted by the
  // set_data_plane handler (packages/handlers/src/org.data_plane.set.ts).
  "data_plane.updated",
  // Organisation model credentials (ADR-053). Storing or removing the
  // organisation's own model-vendor key decides whose invoice every assistant
  // completion lands on, which is a privileged credential change (SOC2 CC6.1)
  // exactly like plugin.credential_set above. Emitted by the
  // set_model_credential and delete_model_credential handlers
  // (packages/handlers/src/org.model_credential.{set,delete}.ts). Verifying a
  // key writes nothing and is not audited.
  "model_credential.set",
  "model_credential.revoked",
  // Tool governance (MC spec §6.9, §6.11, ADR-072, #2958). A kill switch
  // flip is the emergency deny an operator issues against a tool version, a
  // tool server, a connection, an agent, an operator, a workspace, the
  // organisation or a consequence class; every flip, on or off, is recorded
  // with who, why and what it stopped (spec §6.11: "every switch flip is a
  // security event"). Reclassifying a tool version changes which class
  // switches and, later, which approval rules reach it, so it is recorded
  // too. Emitted by packages/handlers/src/kill_switch.set.ts and
  // tool.classification.set.ts.
  "tool.kill_switch_flipped",
  "tool.classification_changed",
  // Agent identity (MC spec §6.2, ADR-057, #2956). An agent identity is a
  // principal with a long-lived credential and roles; registering one adds a
  // machine actor to the organisation, suspending or resuming one changes
  // whether every run token it holds is honoured at the next call, and
  // retiring one ends it for good (never deleted: its runs keep their
  // identity). Each is a logical-access change (SOC2 CC6.1/CC6.3) emitted by
  // packages/handlers/src/agent.{register,suspend,retire}.ts; the credential
  // itself is covered by api_key.created / api_key.revoked.
  "agent.registered",
  "agent.suspended",
  "agent.resumed",
  "agent.retired",
  // Witness disclosure (MC spec §8.5 invariant 3, ADR-064, #2955). The grain
  // is how much a worker is told when a witness it cannot see fails; raising
  // it above L0 hands the worker detail about the oracle, so only an org
  // Owner or Admin in a signed-in session changes it. Emitted by the
  // set_disclosure_grain handler (packages/handlers/src/evidence.disclosure_grain.set.ts).
  "evidence.disclosure_grain_changed",
  // Governed agent runs (docs/specs/run-evidence-ingress/spec.md). These four
  // are INTEGRITY failures, not ordinary denials: each one means some part of
  // the run-evidence chain was contradicted, and none can be produced by
  // legitimate use. `capability.invoke_denied` above still covers a routine
  // policy deny — do not overload these for that.
  //
  //   event_sequence_conflict   two events claimed the same (run_seq) or
  //                             (attempt_id, attempt_seq) with DIFFERENT
  //                             payload digests — the ordered stream forked
  //   forged_decision_reference  a caller supplied an authorization-decision
  //                             reference on a CapabilityContext; that binding
  //                             is platform-created and can never be an input
  //   stale_deny_generation      an operation was evaluated against a
  //                             deny-generation older than the current one —
  //                             a cached allow outlived its invalidation
  //   finalization_grant_misuse  a one-shot finalization grant was presented
  //                             for a different attempt, digest, or capability
  //                             than the seal it was minted for
  //
  // Only the first is spelled by live code (EVENT_SEQUENCE_CONFLICT_EVENT in
  // packages/run-ledger/src/run-store.ts). The other three are RESERVED — no
  // emitter: the detectors that would raise them are not yet wired.
  "agent_run.event_sequence_conflict",
  "agent_run.forged_decision_reference",
  "agent_run.stale_deny_generation",
  "agent_run.finalization_grant_misuse",
  // Mandates (MC spec §6.9 part 3, ADR-059): the grant, the limits change,
  // the revocation, the hourly expiry, and a call the gate refused
  // (no_mandate, target_denied, over_limit) — the spec catalog's
  // `mandate.exception`. Emitted by packages/handlers/src/mandate.*.ts,
  // packages/inngest-functions/src/functions/mandate.expiry.ts and
  // packages/rules/src/mandates.ts.
  "mandate.granted",
  "mandate.limits_changed",
  "mandate.revoked",
  "mandate.expired",
  "mandate.exception",
  // Auto-approval (MC spec §6.9 part 2, ADR-070): a call a decision rule sent
  // to a person that an auto-approval rule released instead, recorded with
  // `policy:<rule id>` as its approver. Emitted by
  // packages/rules/src/auto-approval-path.ts.
  "approval.auto_approved",
  // The rules themselves: written, switched off, or deleted. Emitted by
  // packages/handlers/src/approval_rule.*.ts.
  "approval_rule.changed",
  "approval_rule.invalidated",
  "approval_rule.deleted",
  // Access review
  "access.review_completed",
  "access.member_access_confirmed",
  // Privacy / GDPR
  "privacy.export_requested",
  "privacy.erasure_requested",
  "privacy.org_erasure_requested",
  // Steering (ADR-061): a Context PR merged and published a record — the
  // bundle a workspace's agents read changed. Emitted by merge_context_pr.
  "steering.published",
  // The mode itself changed: `.oxagen/rules/governance.toml` was committed to
  // the production branch, so a different rule now decides who may merge a
  // Context PR. Emitted by set_governance_mode. A change that went to review
  // instead emits nothing — the pull request is the record, and the mode in
  // force has not moved until a person merges it.
  "steering.governance_changed",
  // The same commit, made although the mode in force asked for review. It
  // rides ALONGSIDE steering.governance_changed rather than replacing it, so
  // that "every governance change" and "every skipped review" are each one
  // event-type filter and neither answer is missing rows.
  "steering.governance_overridden",
  // Enterprise SSO (ADR-145). Provider lifecycle, in order: an org admin
  // registers an OIDC or SAML provider, proves the email domain with a DNS
  // TXT record, edits it, removes it. Emitted by the org.sso.* handlers.
  "sso.provider_created",
  "sso.domain_verified",
  "sso.provider_updated",
  "sso.provider_deleted",
  // The org turned "require SSO" on or off (set_sso_policy).
  "sso.policy_updated",
  // The IdP group → Oxagen role table changed (set_sso_group_roles).
  "sso.group_roles_set",
  // Every sign-in through an SSO provider, success or not. `outcome: "deny"`
  // when no IdP group the person carries is mapped, so the sign-in granted
  // nothing in the org. Emitted from packages/auth/src/sso/provision.ts.
  "sso.sign_in",
] as const;

// ---------------------------------------------------------------------------
// RESERVED vs EMITTED — the machine-readable half of the note above.
// ---------------------------------------------------------------------------

/**
 * Types that are DECLARED but that nothing in the repo writes.
 *
 * The comments above mark these in prose; this is the same fact in a form code
 * can consult. An audit UI that offers a reserved type as a filter returns zero
 * rows, which looks exactly like "this never happened" when the true answer is
 * "we do not log this yet" — a compliance tool misleading the person running
 * the audit (#2528).
 *
 * Kept in sync by `security-event-types.test.ts`, which greps the repo for each
 * literal and fails in BOTH directions: a reserved type that gained an emitter,
 * and a non-reserved type that lost its last one. The note above says these
 * markers are hand-maintained and unchecked — they are checked now.
 */
export const RESERVED_SECURITY_EVENT_TYPES = [
  // Better Auth hooks emit only sign_in and sign_out.
  "auth.token_refreshed",
  "auth.password_changed",
  "auth.email_verified",
  // There is no org plugin denylist.
  "plugin.denylist_added",
  "plugin.denylist_removed",
  // The detectors that would raise these three are not yet wired; only
  // agent_run.event_sequence_conflict is spelled by live code.
  "agent_run.forged_decision_reference",
  "agent_run.stale_deny_generation",
  "agent_run.finalization_grant_misuse",
] as const satisfies readonly SecurityEventType[];

export type ReservedSecurityEventType =
  (typeof RESERVED_SECURITY_EVENT_TYPES)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(
  RESERVED_SECURITY_EVENT_TYPES,
);

/**
 * The types something actually writes — what an audit filter should offer.
 *
 * Derived rather than listed a second time, so the two cannot drift: this is
 * exactly `SECURITY_EVENT_TYPES` minus
 * {@link RESERVED_SECURITY_EVENT_TYPES}. The database CHECK constraint stays on
 * the FULL union; this narrows what a UI offers, never what the column accepts.
 */
export const EMITTED_SECURITY_EVENT_TYPES: readonly SecurityEventType[] =
  SECURITY_EVENT_TYPES.filter((t) => !RESERVED_SET.has(t));

/** Whether anything in the repo writes this event type. */
export function isEmittedSecurityEventType(type: SecurityEventType): boolean {
  return !RESERVED_SET.has(type);
}

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// SECURITY_OUTCOMES — the authz / lifecycle outcome set. Mirrors the
// security_events.outcome CHECK constraint.
// ---------------------------------------------------------------------------

export const SECURITY_OUTCOMES = ["allow", "deny", "error", "success"] as const;

export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Membership guards — O(1) narrowing for untrusted strings.
//
// Sole caller today is the audit-log filter parser
// (apps/app/src/lib/audit-filters.ts), which drops unrecognised values out of a
// user-supplied query string. The insert path does NOT call these: emitters are
// typed against SecurityEventType at compile time and the DB CHECK constraint is
// the runtime backstop.
// ---------------------------------------------------------------------------

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(SECURITY_EVENT_TYPES);
const OUTCOME_SET: ReadonlySet<string> = new Set(SECURITY_OUTCOMES);

/** Type guard: is `value` a known SecurityEventType? */
export function isSecurityEventType(value: string): value is SecurityEventType {
  return EVENT_TYPE_SET.has(value);
}

/** Type guard: is `value` a known SecurityOutcome? */
export function isSecurityOutcome(value: string): value is SecurityOutcome {
  return OUTCOME_SET.has(value);
}

/** Evidence recorded when a tool change disables a previously authorized rule. */
export interface ApprovalRuleInvalidationDetail {
  ruleId: string;
  tool: string;
  reason: "classification_changed" | "measure_changed" | "tool_scope_changed";
  before: ApprovalToolChangeEvidence | null;
  after: ApprovalToolChangeEvidence;
}

export interface ApprovalToolChangeEvidence {
  consequenceTags: readonly string[];
  measures: unknown;
  classification: unknown;
}

/**
 * Evidence recorded when `set_governance_mode` commits
 * `.oxagen/rules/governance.toml` to a repository's production branch.
 *
 * `previousMode` is null when the file was absent or could not be parsed —
 * not `"team"`. The default a missing file falls back to is a read-time rule
 * in `parseGovernanceMode`; writing it here would claim the repository said
 * something it never said, which is the one thing an audit row must not do.
 *
 * `overrodeReview` is the fact the override exists to leave behind: the mode
 * in force asked for a pull request and this caller committed anyway. The
 * same call emits `steering.governance_overridden` when it is true.
 */
export interface GovernanceChangeDetail {
  /** `owner/name` of the repository whose governance file was written. */
  fullName: string;
  /** The branch the commit landed on. */
  productionBranch: string;
  /** The mode the file declared before, or null when absent or unparseable. */
  previousMode: "solo" | "team" | "regulated" | null;
  /** The mode in force from this commit onwards. */
  mode: "solo" | "team" | "regulated";
  /** The commit that carries the change. */
  commitSha: string;
  /** Whether the review route the mode in force asked for was skipped. */
  overrodeReview: boolean;
}

/**
 * Everything `security_events.detail` may carry.
 *
 * The column is jsonb with no CHECK, so this union is the only thing keeping
 * it a small set of known shapes rather than a scratch pad. Widen it by
 * adding a named interface, never by reaching for `Record<string, unknown>`:
 * an audit reader has to be able to know what a row means.
 */
/**
 * Evidence recorded on an SSO provider's lifecycle events
 * (`sso.provider_created`, `sso.domain_verified`, `sso.provider_updated`,
 * `sso.provider_deleted`). It names the provider and never carries its
 * configuration: a client secret or a signing key has no place in an audit
 * row.
 */
export interface SsoProviderChangeDetail {
  /** The provider's stable id, as it appears in its callback URL. */
  providerId: string;
  protocol: "oidc" | "saml";
  /** The email domain the provider signs people in for. */
  domain: string;
  /** For `sso.provider_updated`: the top-level fields the change touched. */
  changedFields?: readonly string[];
}

/**
 * Evidence recorded on `sso.sign_in`.
 *
 * `groups` is what the identity provider asserted and `grantedRole` is what
 * the mapping table turned it into, so a reader can tell "the IdP sent no
 * groups" from "the IdP sent groups nobody mapped". `grantedRole` is null when
 * the sign-in granted nothing. `previousRole` is the org role the person held
 * before this sign-in, so a demotion or a removal is visible in one row.
 */
export interface SsoSignInDetail {
  providerId: string;
  /** The IdP groups on the assertion, capped at 50 entries. */
  groups: readonly string[];
  grantedRole: string | null;
  previousRole: string | null;
  reason:
    | "mapped"
    | "no_mapped_group"
    | "owner_unmanaged"
    | "not_entitled"
    | "provision_failed";
}

/** Evidence recorded on `sso.policy_updated`. */
export interface SsoPolicyDetail {
  ssoRequired: boolean;
}

/** Evidence recorded on `sso.group_roles_set`: the table after the write. */
export interface SsoGroupRolesDetail {
  providerId: string;
  mappings: readonly { group: string; role: string }[];
}

export type SecurityEventDetail =
  | ApprovalRuleInvalidationDetail
  | GovernanceChangeDetail
  | SsoProviderChangeDetail
  | SsoSignInDetail
  | SsoPolicyDetail
  | SsoGroupRolesDetail;
