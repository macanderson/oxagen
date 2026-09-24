import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgSchema } from "./_schemas";
import { auditMixin, bytea, citext, idMixin, softDeleteMixin } from "./_mixins";
import { ssoProviderTable } from "./auth";

export const organizations = orgSchema.table(
  "organizations",
  {
    ...idMixin("org"),
    ...auditMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    // Immutable, globally-unique handle (like a Linear team key). SEPARATE from
    // slug on purpose: slugs are renameable (org_slug_history), namespaces never
    // change once set (enforced by the organizations_namespace_immutable
    // trigger). It anchors the agentKey org_ns.workspace_ns.agent_slug, whose
    // 32-char budget is 6 (org) + 1 + 6 (workspace) + 1 + 18 (agent slug).
    // Derived from the slug at creation via deriveNamespace().
    namespace: citext("namespace").notNull(),
    // Org avatar/logo. Nullable: orgs render initials until a logo is uploaded.
    // Stores the public blob URL returned by the storage adapter (Vercel Blob).
    avatarUrl: text("avatar_url"),
    planType: text("plan_type").notNull(),
    /**
     * The governed-action commitment for an org with no `billing.plans` row to
     * carry one (ADR-052 §4.2). NULL keeps the tier default — for enterprise
     * that is `resolveActionAllowance`'s scale fallback plus its
     * `billing_enterprise_allowance_missing` alert, because "negotiated" must
     * never be read as "unlimited". The plan row still wins when an entitled
     * subscription points at one; this is only the legacy tier leg's way to
     * record a figure for an org that never went through Stripe checkout.
     * CHECK: NULL OR >= 0.
     */
    negotiatedActionsAnnual: bigint("negotiated_actions_annual", {
      mode: "bigint",
    }),
    status: text("status").notNull(),
    // Discriminator: 'personal' = solo user, 'business' = team/company.
    // Business orgs unlock team features, billing profiles, and enterprise
    // controls. CHECK enforced below.
    type: text("type").notNull().default("business"),
    // Business-only profile fields. NULL on personal orgs.
    website: text("website"),
    industry: text("industry"),
    // CHECK: closed size-range slugs or NULL (personal orgs omit).
    employeeSize: text("employee_size"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    slugIdx: uniqueIndex("organizations_slug_idx").on(t.slug),
    // Namespace is globally unique + immutable. The immutability itself is
    // enforced by a BEFORE UPDATE trigger (see migration
    // 20260709120000_namespace_identity), not expressible in Drizzle DDL.
    namespaceIdx: uniqueIndex("organizations_namespace_idx").on(t.namespace),
    namespaceCheck: check(
      "organizations_namespace_check",
      sql`${t.namespace} ~ '^[a-z0-9]{2,6}$'`,
    ),
    statusIdx: index("organizations_status_idx").on(t.status),
    typeCheck: check(
      "organizations_type_check",
      sql`${t.type} IN ('personal','business')`,
    ),
    // Mirrors billing.plans.included_gau_per_month's own bound: a negative
    // commitment is not a smaller one, it is a corrupt row. (This named
    // `included_actions_annual` until migration 20260915120000 dropped that
    // column; the plan-side figure is monthly now and the annual one is twelve
    // of it — see resolveOrgActionEntitlement.)
    negotiatedActionsAnnualCheck: check(
      "organizations_negotiated_actions_annual_check",
      sql`${t.negotiatedActionsAnnual} IS NULL OR ${t.negotiatedActionsAnnual} >= 0`,
    ),
    // NULL is valid (personal orgs and business orgs that skipped the field).
    employeeSizeCheck: check(
      "organizations_employee_size_check",
      sql`${t.employeeSize} IS NULL OR ${t.employeeSize} IN ('1','2-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10000+')`,
    ),
    statusCheck: check(
      "organizations_status_check",
      sql`${t.status} IN ('active', 'suspended', 'deleted')`,
    ),
  }),
);

export const orgUsers = orgSchema.table(
  "org_users",
  {
    ...idMixin("oru"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    orgUserIdx: uniqueIndex("org_users_org_user_idx").on(t.orgId, t.userId),
    userIdx: index("org_users_user_idx").on(t.userId),
    // Membership role is written in BOTH casings today: lowercase by the
    // org/workspace create + onboarding paths, Capitalized by
    // workspace.invite.send's mapRole() and the IAM-role-name path in
    // org.member.role.change. Case-insensitive CHECK over the canonical role
    // set (iam-provision.ts ORG_ROLES/WORKSPACE_ROLES — a fixed seeded set, no
    // custom-role path) rejects garbage without breaking either writer.
    roleCheck: check(
      "org_users_role_check",
      sql`lower(${t.role}) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer')`,
    ),
  }),
);

// ── Invitations ───────────────────────────────────────────────────────────────
// Each invitation occupies a seat (pending invites count as used seats).
// One active invitation per (orgId, email); multiple can exist historically
// (accepted/declined/revoked/expired are not blocked by the partial unique index).

// Slug-history capture for org renames. Every time organizations.slug changes,
// the write path inserts one row in the SAME transaction as the slug UPDATE
// (atomic capture). The resolver consults this table on a current-slug miss to
// 301/308-redirect the old URL to the canonical new one (spec §4.5, §6.1).
// redirect_enabled=false freezes a row so the old URL 404s again — used when a
// slug is intentionally retired or recycled.
//
// old_slug is intentionally NOT unique: a re-rename chain (a→b, then b→c, then
// a→c by another org after the first org freed "a") can produce repeated
// old_slug values. The resolver picks the most recent matching row by
// changed_at DESC.
export const orgSlugHistory = orgSchema.table(
  "org_slug_history",
  {
    ...idMixin("osh"),
    orgId: uuid("org_id").notNull(),
    oldSlug: citext("old_slug").notNull(),
    newSlug: citext("new_slug").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    redirectEnabled: boolean("redirect_enabled").notNull().default(true),
  },
  (t) => ({
    // Resolver hot path: lookup by old_slug.
    oldSlugIdx: index("org_slug_history_old_slug_idx").on(t.oldSlug),
    // Inverse lookup for admin tooling ("show rename history for this org").
    orgIdx: index("org_slug_history_org_idx").on(t.orgId, t.changedAt),
  }),
);

export const invitations = orgSchema.table(
  "invitations",
  {
    ...idMixin("invi"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    // citext for case-insensitive uniqueness
    email: citext("email").notNull(),
    // The org role to assign on accept (e.g. 'Admin', 'Member')
    role: text("role").notNull(),
    // CHECK: status IN ('pending','accepted','declined','revoked','expired')
    status: text("status").notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    acceptedUserId: uuid("accepted_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Fast lookup: active invitations for an org
    orgStatusIdx: index("invitations_org_status_idx").on(t.orgId, t.status),
    // Prevent duplicate pending invitations for the same email in an org
    pendingEmailIdx: uniqueIndex("invitations_org_email_pending_idx")
      .on(t.orgId, t.email)
      .where(sql`${t.status} = 'pending'`),
    statusCheck: check(
      "invitations_status_check",
      sql`${t.status} IN ('pending','accepted','declined','revoked','expired')`,
    ),
    // invitations.role holds the IAM role NAME to assign on accept — a value
    // from the fixed per-org seeded set (iam-provision.ts), stored Title-cased
    // (e.g. 'Admin', 'Member'). Case-insensitive CHECK over the canonical set;
    // there is no custom-role-creation path, so the set is closed.
    roleCheck: check(
      "invitations_role_check",
      sql`lower(${t.role}) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer')`,
    ),
  }),
);

// ── Organisation-scoped data planes (ADR-042) ────────────────────────────────
// One row per (organisation, store kind) binding the organisation's traces,
// graph, and evidence to a physical endpoint. Absence of a row means the
// SHARED platform plane — the table is sparse by design, and a fresh
// deployment has none at all.
//
// `config_ciphertext` is the KMS envelope (@oxagen/crypto `encrypt`, the same
// envelope the credential vault uses) over the JSON connection config. The
// plaintext DSN NEVER exists in a column, a log line, a read capability's
// output, or an error message: `get_data_plane` returns host + database name
// only. `config_key_id` records which KEK wrapped the DEK so a rotation can
// route the decrypt, and `config_digest` is a SHA-256 over the canonical
// plaintext config — it is the cache/pool key the store clients evict on, so
// a rotated credential produces a new key rather than reusing a pool bound to
// a revoked password. A digest of a secret is not a secret: it is
// preimage-resistant and the config carries a high-entropy password.
//
// This is a PLATFORM-LEVEL org-scoped settings table, like
// billing.org_billing_settings and security.org_security_policy: org_id NOT
// NULL, no workspace_id → the `org_only` RLS class. It always lives on the
// shared plane (a plane binding cannot be stored on the plane it describes),
// which is why every access goes through withSystemDb.
export const dataPlanes = orgSchema.table(
  "data_planes",
  {
    ...idMixin("dpl"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // Which store this binding governs. CHECK enforced below.
    kind: text("kind").notNull(),
    // 'shared' = the platform plane (config columns stay NULL);
    // 'dedicated' = a customer-controlled endpoint (config columns required).
    mode: text("mode").notNull().default("shared"),
    // KMS envelope over the JSON connection config. NULL on a shared row.
    configCiphertext: bytea("config_ciphertext"),
    configKeyId: text("config_key_id"),
    configDigest: text("config_digest"),
    status: text("status").notNull().default("active"),
    // Applied schema version of a dedicated plane. A plane lagging the
    // platform is marked `degraded` and its writes fail closed (ADR-042 §3).
    schemaVersion: text("schema_version"),
    lastVerifiedAt: timestamp("last_verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    rotatedAt: timestamp("rotated_at", {
      withTimezone: true,
      mode: "date",
    }),
    // ADR-098: the organisation's own database on the SHARED Neo4j cluster
    // (`org-<namespace>`), written when an OrgGraphProvisioner creates it.
    // NULL = the pooled database. Only on a shared-mode neo4j row; CHECK below.
    graphDatabase: text("graph_database"),
  },
  (t) => ({
    // One LIVE binding per (organisation, store). Partial on deleted_at so a
    // retired binding stays readable as history without blocking a new one.
    orgKindIdx: uniqueIndex("data_planes_org_kind_idx")
      .on(t.orgId, t.kind)
      .where(sql`${t.deletedAt} IS NULL`),
    kindCheck: check(
      "data_planes_kind_check",
      sql`${t.kind} IN ('postgres','neo4j','clickhouse')`,
    ),
    modeCheck: check(
      "data_planes_mode_check",
      sql`${t.mode} IN ('shared','dedicated')`,
    ),
    statusCheck: check(
      "data_planes_status_check",
      sql`${t.status} IN ('active','degraded','disabled')`,
    ),
    // A dedicated plane is unusable without its envelope; a shared plane must
    // not carry one. Enforcing the pairing in the database means a partial
    // write can never produce a row the resolver has to guess about.
    configPairingCheck: check(
      "data_planes_config_pairing_check",
      sql`(${t.mode} = 'shared' AND ${t.configCiphertext} IS NULL AND ${t.configKeyId} IS NULL)
       OR (${t.mode} = 'dedicated' AND ${t.configCiphertext} IS NOT NULL AND ${t.configKeyId} IS NOT NULL)`,
    ),
    graphDatabaseCheck: check(
      "data_planes_graph_database_check",
      sql`${t.graphDatabase} IS NULL OR (${t.kind} = 'neo4j' AND ${t.mode} = 'shared' AND ${t.graphDatabase} ~ '^org-[a-z0-9]{2,6}$')`,
    ),
  }),
);

// ── Organisation model credentials (ADR-053) ─────────────────────────────────
//
// The organisation's own model-vendor API key, envelope-encrypted. While a row
// is live the in-app agent's completions run on the customer's key and Oxagen
// bills nothing for those tokens; with no row the platform key pays and the
// tokens are billed as assistant usage. One live row per organisation. Org-only
// (no workspace_id → the `org_only` RLS class), and read through withTenantDb
// because, unlike a data-plane binding, nothing resolves THROUGH this table.
export const modelCredentials = orgSchema.table(
  "model_credentials",
  {
    ...idMixin("mcr"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // Which vendor the key belongs to. CHECK enforced below.
    provider: text("provider").notNull(),
    // KMS envelope over the plaintext key. Never NULL on a live row — the
    // pairing CHECK below refuses a row with no ciphertext, so a partial write
    // cannot produce a credential the resolver has to guess about.
    keyCiphertext: bytea("key_ciphertext").notNull(),
    keyKeyId: text("key_key_id").notNull(),
    // SHA-256 of the plaintext key. The provider-client cache key: a rotated
    // key produces a different digest, misses the cache, and the client built
    // on the revoked key is dropped rather than retried.
    keyDigest: text("key_digest").notNull(),
    // Last four characters of the key — what a vendor dashboard shows, and what
    // an operator needs to tell two keys apart. Not a secret.
    keyHint: text("key_hint").notNull(),
    // The customer's own endpoint, for `openai_compatible` credentials only.
    // NULL for every provider whose URL Oxagen spells; the pairing CHECK below
    // enforces both directions, so a row can never carry an endpoint the
    // provider client would ignore, nor omit one the client cannot build
    // without. Not a secret: the settings page reads it back to show an
    // operator what they configured.
    baseUrl: text("base_url"),
    // Which concrete model each white-labeled tier means on THIS key, as
    // `{ fast?, balanced?, precise? }`. Empty for a routed provider, which
    // understands the platform's gateway-shaped ids already. `{}` rather than
    // NULL so every reader gets an object and none has to branch.
    modelMap: jsonb("model_map").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("active"),
    lastVerifiedAt: timestamp("last_verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    rotatedAt: timestamp("rotated_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // One LIVE credential per organisation. Partial on deleted_at so a revoked
    // key stays readable as history without blocking a new one.
    orgIdx: uniqueIndex("model_credentials_org_idx")
      .on(t.orgId)
      .where(sql`${t.deletedAt} IS NULL`),
    providerCheck: check(
      "model_credentials_provider_check",
      sql`${t.provider} IN ('openrouter','gateway','openai','anthropic','openai_compatible')`,
    ),
    // The endpoint and the provider agree, in BOTH directions: exactly the
    // providers whose URL the customer supplies carry one. Without the second
    // half a row could name `openrouter` and carry a base_url that the client
    // silently ignores — a stored setting with no effect, which reads to an
    // operator as a bug in the assistant rather than in the row.
    baseUrlPairingCheck: check(
      "model_credentials_base_url_pairing_check",
      sql`(${t.provider} = 'openai_compatible') = (${t.baseUrl} IS NOT NULL)`,
    ),
    // An endpoint we will attach an API key to must be TLS. The range check
    // that keeps it off loopback and the metadata address cannot be expressed
    // here and runs in the handler (`@oxagen/config/public-url`); this is the
    // half the database can hold, so a row written by any future path still
    // cannot carry `http://`.
    baseUrlTlsCheck: check(
      "model_credentials_base_url_tls_check",
      sql`${t.baseUrl} IS NULL OR ${t.baseUrl} LIKE 'https://%'`,
    ),
    statusCheck: check(
      "model_credentials_status_check",
      sql`${t.status} IN ('active','disabled')`,
    ),
    keyHintCheck: check(
      "model_credentials_key_hint_check",
      sql`length(${t.keyHint}) <= 4`,
    ),
  }),
);

// ── assistant_model_keys ─────────────────────────────────────────────────────
// The OpenRouter key Oxagen mints for one organisation (ADR-131).
//
// The neighbouring `model_credentials` is the key a CUSTOMER brought: their
// vendor invoice, and Oxagen bills nothing for those tokens. A row here is a
// key OXAGEN minted on its own account and handed to one organisation:
// Oxagen's invoice, metered and billed as assistant usage exactly as on the
// single shared key it replaces. This table changes which key spends, never
// who pays — `resolveModelFundingSource` still answers `platform` for an
// organisation whose only key is this one.
//
// Why per-organisation: a runaway turn hits `dailyLimitUsd` instead of the
// account ceiling every other customer's assistant depends on; OpenRouter
// reports usage per key, so an invoice line has a per-customer figure that
// does not come from Oxagen's own meter; and one customer can be cut off
// without touching anyone else.
//
// One row per organisation forever — `orgId` is UNIQUE with no soft-delete
// predicate, because a rotation updates the row. That uniqueness IS the
// provisioner's idempotence: a racing second caller loses the insert and
// deletes the key it had just minted at the vendor.
export const assistantModelKeys = orgSchema.table(
  "assistant_model_keys",
  {
    ...idMixin("amk"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // Only OpenRouter mints keys on demand today. The CHECK is narrow on
    // purpose: widening it is a decision about a second vendor account, not a
    // column edit.
    provider: text("provider").notNull().default("openrouter"),
    // The vendor's durable handle — what every later call is addressed by and
    // what an OpenRouter usage export joins to this organisation. Not secret.
    keyHash: text("key_hash").notNull(),
    // `oxagen/<slug-at-creation>/<creator email>`. A label for people, never
    // rewritten; the identity is keyHash. See `assistantKeyName`.
    keyName: text("key_name").notNull(),
    // KMS envelope over the plaintext key, same shape as modelCredentials.
    keyCiphertext: bytea("key_ciphertext").notNull(),
    keyKeyId: text("key_key_id").notNull(),
    // SHA-256 of the plaintext — the provider-client cache key, so a rotated
    // key misses the cache and the client built on the old one is dropped.
    keyDigest: text("key_digest").notNull(),
    // Last four characters. Not a secret; the CHECK holds it to four.
    keyHint: text("key_hint").notNull(),
    // The ceiling OpenRouter refills at midnight UTC, in USD. Stored as well
    // as sent, so a drift check can ask the vendor what it believes the
    // ceiling is rather than assume the call that set it landed.
    dailyLimitUsd: numeric("daily_limit_usd", {
      precision: 10,
      scale: 2,
    }).notNull(),
    status: text("status").notNull().default("active"),
    provisionedAt: timestamp("provisioned_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Why the last attempt failed, for an operator reading a row that exists
    // and cannot serve. Scrubbed of key material by the writer.
    lastError: text("last_error"),
  },
  (t) => ({
    orgIdx: uniqueIndex("assistant_model_keys_org_unique").on(t.orgId),
    // Two organisations on one vendor key would make every usage figure
    // ambiguous, which is the whole reason the table exists.
    hashIdx: uniqueIndex("assistant_model_keys_hash_unique").on(t.keyHash),
    providerCheck: check(
      "assistant_model_keys_provider_check",
      sql`${t.provider} IN ('openrouter')`,
    ),
    statusCheck: check(
      "assistant_model_keys_status_check",
      sql`${t.status} IN ('active','disabled')`,
    ),
    keyHintCheck: check(
      "assistant_model_keys_key_hint_check",
      sql`length(${t.keyHint}) <= 4`,
    ),
    // A zero ceiling is not a smaller ceiling, it is a key that can never
    // answer. An operator who wants that sets status='disabled'.
    dailyLimitCheck: check(
      "assistant_model_keys_daily_limit_check",
      sql`${t.dailyLimitUsd} > 0`,
    ),
    // status and disabledAt agree in both directions, so "is this key off?"
    // has one answer however it is asked.
    disabledPairingCheck: check(
      "assistant_model_keys_disabled_pairing_check",
      sql`(${t.status} = 'disabled') = (${t.disabledAt} IS NOT NULL)`,
    ),
  }),
);

// ── onboarding_state ─────────────────────────────────────────────────────────
// The onboarding gate (MC spec App. F, mockup `OB_STEPS`; #2967). One row per
// organization, written by `create_org` at the moment the organization exists
// (the mockup's `organization` step is complete), advanced by
// `advance_onboarding` between `wrap` and `run`, and closed by the first frame
// `ingest_tacho_events` accepts from one of the organization's hosts, which is
// the only writer of `unlocked` and of `first_frame_at` / `first_run_id`. The
// provisional window (spec §3: 14 days without a main repo) is `provisional_
// until` with `main_repo_bound_at` null; `bind_main_repository` closes it. An
// organization created before this table existed has no row: it was never
// provisional and no first frame is known for it, and every reader treats the
// missing row as an open gate with no window. Org-only RLS.
export const PROVISIONAL_DAYS = 14;

export const onboardingState = orgSchema.table(
  "onboarding_state",
  {
    orgId: uuid("org_id").primaryKey(),
    // The gate's workspace: the first one, made by create_org. App-enforced.
    workspaceId: uuid("workspace_id").notNull(),
    step: text("step").notNull().default("wrap"),
    firstFrameAt: timestamp("first_frame_at", {
      withTimezone: true,
      mode: "date",
    }),
    // The public id of the run the first frame opened (`tse_…`), the row Fleet reads.
    firstRunId: text("first_run_id"),
    provisionalUntil: timestamp("provisional_until", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    mainRepoBoundAt: timestamp("main_repo_bound_at", {
      withTimezone: true,
      mode: "date",
    }),
    // The git remote the enrolling host reported: `{ provider, owner, name }`.
    // Written once by enroll_host while the gate is open; the app offers it
    // to bind_main_repository. Null until a host reports one.
    detectedRepository: jsonb("detected_repository"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    stepCheck: check(
      "onboarding_state_step_check",
      sql`${t.step} IN ('wrap', 'run', 'unlocked')`,
    ),
    // `unlocked`, the instant and the run id arrive together, from the one
    // writer (`unlockOnboardingGate`): a row is unlocked exactly when it
    // carries the frame that opened it.
    firstFrameCheck: check(
      "onboarding_state_first_frame_check",
      sql`(${t.step} = 'unlocked') = (${t.firstFrameAt} IS NOT NULL) AND (${t.firstFrameAt} IS NULL) = (${t.firstRunId} IS NULL)`,
    ),
  }),
);

// ── SSO group → role mappings (ADR-145) ──────────────────────────────────────
//
// The table an org admin edits on the Roles page: one row per identity-provider
// group that grants an organisation role. On every SSO sign-in the groups the
// IdP asserts are looked up here and the highest-ranked mapped role replaces
// the person's org role. Deny by default: a group with no row grants nothing,
// and a person none of whose groups has a row is left with no org role.
//
// Owner is not mappable (the CHECK below): ownership is transferred by a
// person, never minted by an IdP. Rows are replaced wholesale by
// set_sso_group_roles and hard-deleted with their provider (ON DELETE CASCADE).
// org_only RLS; the sign-in path reads it through withSystemDb because no
// tenant scope exists yet.
export const ssoGroupRoles = orgSchema.table(
  "sso_group_roles",
  {
    ...idMixin("sgr"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => ssoProviderTable.providerId, { onDelete: "cascade" }),
    // The group name exactly as the IdP sends it. Compared case-sensitively,
    // because IdPs treat "Admins" and "admins" as different groups.
    idpGroup: text("idp_group").notNull(),
    // An org role name, lowercase: admin, compliance or billing (the org IAM
    // roles), or member (membership with no org-wide role, as an invitation
    // grants).
    role: text("role").notNull(),
  },
  (t) => ({
    groupIdx: uniqueIndex("sso_group_roles_provider_group_idx").on(
      t.providerId,
      t.idpGroup,
    ),
    orgIdx: index("sso_group_roles_org_idx").on(t.orgId),
    roleCheck: check(
      "sso_group_roles_role_check",
      sql`${t.role} IN ('admin', 'compliance', 'billing', 'member')`,
    ),
  }),
);

// ── SCIM 2.0 provisioning (#3734) ────────────────────────────────────────────
//
// An identity provider pushes users and groups to /api/scim/v2 with a bearer
// token one organization's Owner or Admin minted on the Single sign-on page.
// Only the token's SHA-256 is stored, as auth.api_keys stores a key: the server
// compares a presented token and never reads one back, so a leaked row gives
// nobody anything to present. `token_prefix` is the indexed lookup window. One
// live token per organization; rotating revokes the old row and inserts a new
// one in the same transaction. Revoked rows stay as the record of who minted
// what and when.
//
// org_only RLS. Every read runs through withSystemDb, because a SCIM request
// has no tenant scope until its token names the organization, so the policy is
// the backstop rather than the filter.
export const scimTokens = orgSchema.table(
  "scim_tokens",
  {
    ...idMixin("sct"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedById: uuid("revoked_by_id"),
  },
  (t) => ({
    prefixIdx: uniqueIndex("scim_tokens_token_prefix_idx").on(t.tokenPrefix),
    liveIdx: uniqueIndex("scim_tokens_org_live_idx")
      .on(t.orgId)
      .where(sql`${t.revokedAt} IS NULL`),
    hashCheck: check(
      "scim_tokens_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

// The groups an identity provider pushed. SCIM needs an id to answer with and
// the member list to recompute roles from; nothing else about a group is kept.
// A group decides a role only through org.sso_group_roles, matched on its
// display name or its external id, so one mapping table serves SSO sign-in and
// SCIM alike. Hard-deleted on DELETE /Groups/{id}; the security event is the
// record.
export const scimGroups = orgSchema.table(
  "scim_groups",
  {
    ...idMixin("scg"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
  },
  (t) => ({
    orgNameIdx: uniqueIndex("scim_groups_org_display_name_idx").on(
      t.orgId,
      t.displayName,
    ),
    orgExternalIdx: index("scim_groups_org_external_id_idx").on(
      t.orgId,
      t.externalId,
    ),
  }),
);

// One row per (group, person). `org_id` is repeated from the group so the
// org_only policy applies without a join.
export const scimGroupMembers = orgSchema.table(
  "scim_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroups.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    memberIdx: uniqueIndex("scim_group_members_group_user_idx").on(
      t.groupId,
      t.userId,
    ),
    orgUserIdx: index("scim_group_members_org_user_idx").on(t.orgId, t.userId),
  }),
);
