// Typed Organization values for the Organization component tests
// (ARCHITECTURE.md §5): a role row, a catalogue entry, the roles read, a
// workspace row, one API key, an identity provider and the SSO read, and a
// DataSource that answers the organization reads with what a test hands it while recording the arguments
// it was called with. Every other port refuses, so a section that reads
// outside its own port fails the test rather than passing on a stub.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  ApiKey,
  ModelCredential,
  MemberList,
  Permission,
  Role,
  RoleCatalog,
  SsoProvider,
  SsoSettings,
  Workspace,
  WorkspaceList,
} from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function permissionEntry(
  overrides: Partial<Permission> = {},
): Permission {
  return {
    permission: "run.read",
    group: "Runs",
    description: "Read runs, their approvals and the commands sent to them",
    capabilities: ["list_runs", "get_run", "list_approvals"],
    ...overrides,
  };
}

export function roleRow(overrides: Partial<Role> = {}): Role {
  return {
    id: "rol_7k2m9q4x8r1t5v3w6y0z2a",
    name: "agent.release",
    description: "Cuts releases and opens their pull requests.",
    scope: "workspace",
    kind: "agent",
    builtIn: false,
    permissions: ["run.read"],
    heldBy: 2,
    createdBy: "Priya Natarajan",
    ...overrides,
  };
}

export function roleCatalog(overrides: Partial<RoleCatalog> = {}): RoleCatalog {
  return {
    roles: [roleRow()],
    catalog: [permissionEntry()],
    enforcement: { tier: "enterprise", enforced: true },
    ...overrides,
  };
}

export function workspaceRow(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    slug: "core-platform",
    name: "Core platform",
    role: "Owner",
    archivedAt: null,
    ...overrides,
  };
}

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
    name: "CI runner",
    prefix: "ox_liveliveli",
    createdAt: "2026-09-13T10:00:00.000Z",
    lastUsedAt: "2026-09-14T11:30:00.000Z",
    expiresAt: null,
    revokedAt: null,
    rotatable: true,
    ...overrides,
  };
}

/** An OIDC provider whose domain is proven, with one group mapped to admin. */
export function ssoProvider(overrides: Partial<SsoProvider> = {}): SsoProvider {
  return {
    providerRef: "acme-okta",
    displayName: "Acme Okta",
    protocol: "oidc",
    domain: "acme.com",
    domainVerified: true,
    issuer: "https://acme.okta.com",
    groupsClaim: "groups",
    verification: {
      recordName: "_oxagen-sso.acme.com",
      recordValue: "oxagen-sso-verification=4f9d2c7a",
    },
    callbackUrl: "https://app.oxagen.sh/api/auth/sso/callback/acme-okta",
    spMetadataUrl: null,
    oidc: { clientRef: "0oa1b2c3d4", clientSecretSet: true },
    saml: null,
    groupRoles: [{ group: "oxagen-admins", role: "admin" }],
    ...overrides,
  };
}

/** A SAML provider whose domain is not proven yet, with no mappings. */
export function samlProvider(
  overrides: Partial<SsoProvider> = {},
): SsoProvider {
  return ssoProvider({
    providerRef: "acme-entra",
    displayName: "Acme Entra",
    protocol: "saml",
    domain: "acme.io",
    domainVerified: false,
    issuer: "https://sts.windows.net/acme/",
    verification: {
      recordName: "_oxagen-sso.acme.io",
      recordValue: "oxagen-sso-verification=8b1e5f30",
    },
    callbackUrl: "https://app.oxagen.sh/api/auth/sso/saml2/sp/acs/acme-entra",
    spMetadataUrl:
      "https://app.oxagen.sh/api/auth/sso/saml2/sp/metadata?providerId=acme-entra",
    oidc: null,
    saml: {
      entryPoint: "https://login.microsoftonline.com/acme/saml2",
      spPrivateKeySet: false,
    },
    groupRoles: [],
    ...overrides,
  });
}

export function ssoSettings(overrides: Partial<SsoSettings> = {}): SsoSettings {
  return {
    providers: [ssoProvider()],
    policy: { ssoRequired: false },
    entitled: true,
    ...overrides,
  };
}

type OrgReads = {
  members?: Read<MemberList>;
  roles?: Read<RoleCatalog>;
  workspaces?: Read<WorkspaceList>;
  apiKeys?: Read<ApiKey[]>;
  modelCredential?: Read<ModelCredential>;
  sso?: Read<SsoSettings>;
};

export function orgSource(reads: OrgReads): {
  source: DataSource;
  calls: Record<keyof OrgReads, unknown[][]>;
} {
  const calls: Record<keyof OrgReads, unknown[][]> = {
    members: [],
    roles: [],
    workspaces: [],
    apiKeys: [],
    modelCredential: [],
    sso: [],
  };
  const refuse = () => Promise.reject(new Error("not an Organization read"));
  const answer =
    <T>(read: Read<T> | undefined, name: keyof OrgReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`org.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = {
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse, preferences: refuse },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      transcript: refuse,
      chain: refuse,
      outputs: refuse,
    },
    approvals: { pending: refuse, resolved: refuse },
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: answer(reads.members, "members"),
      roles: answer(reads.roles, "roles"),
      workspaces: answer(reads.workspaces, "workspaces"),
      apiKeys: answer(reads.apiKeys, "apiKeys"),
      modelCredential: answer(reads.modelCredential, "modelCredential"),
      sso: answer(reads.sso, "sso"),
    },
    mandates: { list: refuse, get: refuse },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
    },
  };
  return { source, calls };
}
