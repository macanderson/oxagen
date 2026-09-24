// repository.github-env.test.ts — the GitHub repository flow's environment
// contract, checked against the registry that provisions it (ADR-088).
//
// What this pins. Every service that runs one of these capabilities runs its
// handler IN-PROCESS, through the kernel: `apps/api` over HTTP, `apps/mcp` as
// a tool, `apps/app` through the kernel seam (`apps/app/src/server/kernel.ts`
// calls `invoke()` directly; there is no app→api HTTP path in this repo). So
// every variable a handler reads has to be in the environment contract of
// EVERY one of those services, not just api's.
//
// The defect this exists to prevent. All six of `REQUIRED_GITHUB_APP_ENV` were
// registered `services: ["api"]` (two also "mcp"), and
// `tools/scripts/build-env.ts` renders a service's build environment strictly
// from `services[]` — `if (!meta.services.includes(service)) continue`. The
// declaration therefore said the app needs none of these while the app is where
// they are read. It had been wrong longer than the branch that found it:
// `commit_agent_definition` is invoked from
// `apps/app/src/features/agents/actions.ts` and hits the same credentials
// through `resolveGitHubToken`.
//
// The recurrence, and why the required set is now DERIVED. The first version of
// this test named its services in a literal — `["api", "app"]` — with a comment
// explaining that mcp was deliberately absent because "no MCP tool surfaces the
// settings dialog's capabilities". That was already false when it was written:
// `get_main_repository`, `list_github_installations` and
// `list_installation_repositories` all declare `mcp`, and
// `apps/mcp/src/tools/` carries a tool file for each. So the MCP process read
// the GitHub URLs as unset (`envGithubUrls` is all-or-nothing, so it answered
// "this deployment has no GitHub App configured") and could not open a stored
// token to list installation candidates, and the test written to catch exactly
// that could not see it, because the fact it was missing was the fact it
// hardcoded.
//
// So the services are no longer stated here. Each capability's own contract
// says where it runs — `surfaces[]` for api and mcp, `layers[]` for app — and
// `servicesRunning` turns that into the service list this test demands. Adding
// an MCP tool, or an app binding, to any capability below makes this test
// require its credentials with no edit here.
//
// Why the failure is worth a test at all. It is silent in both directions.
// `REQUIRED_GITHUB_APP_ENV` is all-or-nothing by design, so ONE missing
// variable yields "this deployment has no GitHub App configured" — the same
// screen as a deployment that has deliberately not set one up — rather than an
// error naming the variable. And a token whose adapter is unreachable comes
// back `{ ok: false, reason: "unreadable" }`, which reads as a broken
// connection.
//
// Why iterating the constants catches a new VARIABLE. Both lists are the ones
// the HANDLERS THEMSELVES read: `envGithubUrls` gates on
// `REQUIRED_GITHUB_APP_ENV` and `resolveWorkspaceGithubUserToken` opens an
// envelope with the providers `GITHUB_TOKEN_DECRYPT_ENV` names. A variable
// added to this flow is added to one of those lists to take effect at all, and
// the moment it is, this test holds it to the registry. A test enumerating the
// nine names as a literal would pass over the tenth.
//
// And `everyHandlerReadingThese` catches a new CAPABILITY: it scans this
// package for any handler importing one of the two objects that carry these
// credentials, and fails naming a file that is not in `FLOW`.
//
// What `pnpm env:check` does NOT cover, so nobody reads a green one as this.
// `tools/scripts/env-check.ts` builds a `registryServiceMap` and uses it for
// the OPPOSITE direction only (its "dead declarations" pass): services listed
// with no source reference anywhere. A variable referenced by code that runs in
// `app` while declaring only `api` is referenced, so it is not dead, so
// env-check is blind to it. It reports this exact defect as clean.
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_REGISTRY, type ServiceName } from "@oxagen/config";
import type { CapabilityDeclaration } from "@oxagen/oxagen";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { repositoryInstallationAttach } from "@oxagen/oxagen/contracts/repository.installation.attach";
import { repositoryInstallationCandidates } from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { runIssueProvidersGet } from "@oxagen/oxagen/contracts/run.issue.providers.get";
import { REQUIRED_GITHUB_APP_ENV } from "./repository.main.get";
import { GITHUB_TOKEN_DECRYPT_ENV } from "./repository.github-user-installations";

/**
 * The services that host the capability kernel, and where each one is declared
 * on a contract.
 *
 * This is the one architectural fact the test states rather than derives, and
 * it is the stable one: which PROCESSES run handlers in-process changes when a
 * new runtime is built, not when a capability gains a surface. `cli` is
 * deliberately absent — it is an HTTP client of `api` (`apps/cli/src/lib/api.ts`
 * sends a bearer token to the API), so a capability reaching the CLI puts no
 * credential on the CLI's machine. `docs` and `website` run no kernel.
 *
 * A capability's `surfaces[]` and `layers[]` are read as a union. They answer
 * slightly different questions — `surfaces` is where the capability may be
 * dispatched, `layers` which artifacts exist — and either naming a service is
 * reason enough to provision it there. The union can only over-provision, and
 * over-provisioning costs a variable in an environment file while
 * under-provisioning is the silent breakage this file exists for.
 */
const KERNEL_HOSTS = [
  { service: "api", surface: "api", layer: "api" },
  { service: "mcp", surface: "mcp", layer: "mcp" },
  // `app` is a layer only: `surfaces[]` has no "app" member, because the app
  // does not dispatch over a wire — it calls `invoke()` in its own process.
  { service: "app", surface: null, layer: "app" },
] as const satisfies readonly {
  service: ServiceName;
  surface: string | null;
  layer: string;
}[];

/**
 * The default `surfaces[]` a contract that omits the field carries
 * (AGENTS.md → Capability System). Read here so an omitted field is treated as
 * the promise it actually makes rather than as "runs nowhere".
 */
const DEFAULT_SURFACES = ["api", "mcp"] as const;

/**
 * Which services run `capability`'s handler in-process, read off the
 * capability's own declaration.
 */
function servicesRunning(
  capability: CapabilityDeclaration,
): readonly ServiceName[] {
  const surfaces: readonly string[] = capability.surfaces ?? DEFAULT_SURFACES;
  const layers: readonly string[] = capability.layers;
  return KERNEL_HOSTS.filter(
    (host) =>
      (host.surface !== null && surfaces.includes(host.surface)) ||
      layers.includes(host.layer),
  ).map((host) => host.service);
}

/** One capability of this flow, and the credentials its handler reads. */
interface FlowEntry {
  readonly capability: CapabilityDeclaration;
  /** The handler file in this package, for the scan below. */
  readonly handlerFile: string;
  readonly reads: readonly string[];
  /** What reads them, named in the failure message. */
  readonly via: string;
}

/**
 * The capabilities whose handlers read these credentials.
 *
 * `bind_main_repository` and `list_installation_repositories` mint installation
 * tokens from `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, which are two of
 * `REQUIRED_GITHUB_APP_ENV`'s six — but they do not read the constant, and the
 * constant is the unit this test holds, so listing them here would over-claim
 * the other four. Both already declare every service `get_main_repository`
 * does, so nothing is left unprovisioned by leaving them out.
 */
const FLOW: readonly FlowEntry[] = [
  {
    capability: repositoryMainGet,
    handlerFile: "repository.main.get.ts",
    reads: REQUIRED_GITHUB_APP_ENV,
    via: "envGithubUrls",
  },
  {
    capability: repositoryInstallationCandidates,
    handlerFile: "repository.installation.candidates.ts",
    reads: GITHUB_TOKEN_DECRYPT_ENV,
    via: "resolveWorkspaceGithubUserToken, via githubUserInstallationsDeps",
  },
  {
    capability: repositoryInstallationAttach,
    handlerFile: "repository.installation.attach.ts",
    reads: GITHUB_TOKEN_DECRYPT_ENV,
    via: "resolveWorkspaceGithubUserToken, via githubUserInstallationsDeps",
  },
  // `create_workspace` resolves the installation from the org's GitHub
  // authorization by the repository's owner (ADR-099), through the same
  // candidates read as `list_github_installations`. It runs on the api and
  // mcp surfaces and in the app.
  {
    capability: workspaceCreate,
    handlerFile: "workspace.create.ts",
    reads: GITHUB_TOKEN_DECRYPT_ENV,
    via: "resolveWorkspaceGithubUserToken, via githubUserInstallationsDeps",
  },
  // `get_run_issue_providers` returns the GitHub connect, install and manage
  // URLs beside the Linear connections, minted by the same `envGithubUrls` as
  // `get_main_repository`. The run-outcomes settings read it over the api
  // (`apps/api/src/routes/v1/run.outcomes.settings.ts`) and in the app
  // (`apps/app/src/features/run-outcomes/provider-actions.ts`).
  {
    capability: runIssueProvidersGet,
    handlerFile: "run.issue.providers.get.ts",
    reads: REQUIRED_GITHUB_APP_ENV,
    via: "envGithubUrls",
  },
];

/** Every (capability, variable, service) triple the flow requires. */
const REQUIREMENTS = FLOW.flatMap((entry) =>
  entry.reads.flatMap((name) =>
    servicesRunning(entry.capability).map((service) => ({
      capability: entry.capability.name,
      name,
      service,
      via: entry.via,
    })),
  ),
);

/**
 * The exports that carry these credentials into a handler. A file that imports
 * one of them runs the reads, whatever else it does.
 */
const CREDENTIAL_BEARERS = ["envGithubUrls", "githubUserInstallationsDeps"];

/**
 * The module that DEFINES the shared dependency object. It is not a capability
 * handler — it is what the handlers below take — so it is not in `FLOW` and
 * must not be scanned as a missing entry.
 */
const DEFINING_MODULES = ["repository.github-user-installations.ts"];

/**
 * Every handler file in this package that imports a credential bearer.
 *
 * Only an `import` counts: `repository.github-connection.ts` names
 * `resolveWorkspaceGithubUserToken` in a comment and never calls it, and a
 * comment reads no environment.
 */
function everyHandlerReadingThese(): string[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readdirSync(dir)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !DEFINING_MODULES.includes(file),
    )
    .filter((file) => {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      for (const clause of source.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from/g,
      )) {
        const imported = (clause[1] ?? "").split(",").map(
          (name) =>
            name
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? "",
        );
        if (imported.some((name) => CREDENTIAL_BEARERS.includes(name))) {
          return true;
        }
      }
      return false;
    })
    .sort();
}

describe("the GitHub repository flow's environment contract", () => {
  it.each(REQUIREMENTS)(
    "$name reaches $service, which runs $capability",
    ({ name, service, capability, via }) => {
      const meta = ENV_REGISTRY[name];
      expect(meta, `${name} has no ENV_REGISTRY entry`).toBeDefined();
      expect(
        meta?.services,
        `${name} is read by ${via}, and ${capability}'s contract says it runs in ${service}; add "${service}" to its services[] in packages/config/src/registry.ts — or, if it genuinely does not run there, drop that service from the contract`,
      ).toContain(service);
    },
  );

  // A capability that ran nowhere would satisfy every assertion above without
  // checking anything, and a `FLOW` entry whose contract lost both its surfaces
  // and its app layer would go quiet rather than fail.
  it.each(FLOW)(
    "$capability.name is declared to run somewhere",
    ({ capability }) => {
      expect(servicesRunning(capability).length).toBeGreaterThan(0);
    },
  );

  // The derivation's own premise, stated once so a contract edit that silently
  // drops a surface is a failure here and not just a quieter suite elsewhere.
  it("derives mcp for the capabilities that carry an MCP tool", () => {
    expect(servicesRunning(repositoryMainGet)).toContain("mcp");
    expect(servicesRunning(repositoryInstallationCandidates)).toContain("mcp");
  });

  // The lists are the test's subject, so an empty one would pass every
  // assertion above while proving nothing. Pinning the counts makes a list
  // emptied by a bad refactor fail here rather than go quiet.
  it("checks a non-empty list on both sides", () => {
    expect(REQUIRED_GITHUB_APP_ENV.length).toBe(6);
    expect(GITHUB_TOKEN_DECRYPT_ENV.length).toBe(3);
  });

  // The half `FLOW` cannot derive: a NEW capability wired to these credentials.
  // The contract supplies the services; nothing supplies the capability list,
  // so the source does.
  it("lists every handler in this package that reads these credentials", () => {
    const listed = FLOW.map((entry) => entry.handlerFile).sort();
    for (const file of everyHandlerReadingThese()) {
      expect(
        listed,
        `packages/handlers/src/${file} imports one of ${CREDENTIAL_BEARERS.join(" / ")}, so it reads these credentials, but it is not in FLOW — add it so its contract's services are demanded too`,
      ).toContain(file);
    }
  });

  // `envGithubUrls` refuses to publish a URL unless EVERY name is set, so a
  // name in the list that no registry entry backs cannot be satisfied by any
  // deployment: the door would be shut everywhere, permanently, and the dialog
  // would report the deployment as unconfigured with nothing to configure.
  it.each([...REQUIRED_GITHUB_APP_ENV, ...GITHUB_TOKEN_DECRYPT_ENV])(
    "%s is a variable the registry knows how to provision",
    (name) => {
      expect(Object.keys(ENV_REGISTRY)).toContain(name);
    },
  );
});
