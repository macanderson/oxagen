// repository.github-env.test.ts — the GitHub repository flow's environment
// contract, checked against the registry that provisions it (ADR-088).
//
// What this pins. `apps/app` reaches every capability in-process, through the
// kernel seam (`apps/app/src/server/kernel.ts` calls `invoke()` directly; there
// is no app→api HTTP path in this repo). So the handlers behind the Workspace
// settings dialog — `get_main_repository`, `list_installation_repositories`,
// `list_installation_candidates`, `attach_github_installation`,
// `bind_main_repository` — execute inside the app process, and every variable
// they read has to be in THAT service's environment contract as well as api's.
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
// Why it is worth a test rather than a one-off correction. The failure is
// silent in both directions. `REQUIRED_GITHUB_APP_ENV` is all-or-nothing by
// design, so ONE missing variable yields "this deployment has no GitHub App
// configured" — the same screen as a deployment that has deliberately not set
// one up — rather than an error naming the variable. And a token whose adapter
// is unreachable comes back `{ ok: false, reason: "unreadable" }`, which reads
// as a broken connection.
//
// Why iterating the constants catches the recurrence. Both lists are the ones
// the HANDLERS THEMSELVES read: `envGithubUrls` gates on
// `REQUIRED_GITHUB_APP_ENV` and `resolveWorkspaceGithubUserToken` opens an
// envelope with the providers `GITHUB_TOKEN_DECRYPT_ENV` names. A variable
// added to this flow is added to one of those lists to take effect at all, and
// the moment it is, this test holds it to the registry. A test enumerating the
// nine names as a literal would pass over the tenth.
//
// What `pnpm env:check` does NOT cover, so nobody reads a green one as this.
// `tools/scripts/env-check.ts` builds a `registryServiceMap` and uses it for
// the OPPOSITE direction only (its "dead declarations" pass): services listed
// with no source reference anywhere. A variable referenced by code that runs in
// `app` while declaring only `api` is referenced, so it is not dead, so
// env-check is blind to it. It reports this exact defect as clean.
import { describe, expect, it } from "vitest";
import { ENV_REGISTRY } from "@oxagen/config";
import { REQUIRED_GITHUB_APP_ENV } from "./repository.main.get";
import { GITHUB_TOKEN_DECRYPT_ENV } from "./repository.github-user-installations";

/**
 * The services that run the capability kernel in-process and invoke the
 * repository flow: `api` over HTTP, `app` through the kernel seam.
 *
 * `mcp` is deliberately absent. It runs the kernel too and two of these vars
 * already name it, but no MCP tool surfaces the settings dialog's capabilities,
 * so requiring it here would assert a promise nothing makes. The assertion is
 * a superset check, not equality, so a var naming mcp as well still passes.
 */
const KERNEL_SERVICES = ["api", "app"] as const;

describe("the GitHub repository flow's environment contract", () => {
  it.each([...REQUIRED_GITHUB_APP_ENV])(
    "%s is provisioned to every service that invokes the flow",
    (name) => {
      const meta = ENV_REGISTRY[name];
      expect(meta, `${name} has no ENV_REGISTRY entry`).toBeDefined();
      for (const service of KERNEL_SERVICES) {
        expect(
          meta?.services,
          `${name} is read by envGithubUrls, which runs in ${service}; add "${service}" to its services[] in packages/config/src/registry.ts`,
        ).toContain(service);
      }
    },
  );

  it.each([...GITHUB_TOKEN_DECRYPT_ENV])(
    "%s is provisioned to every service that opens a stored GitHub token",
    (name) => {
      const meta = ENV_REGISTRY[name];
      expect(meta, `${name} has no ENV_REGISTRY entry`).toBeDefined();
      for (const service of KERNEL_SERVICES) {
        expect(
          meta?.services,
          `${name} is read by resolveWorkspaceGithubUserToken, which runs in ${service}; add "${service}" to its services[] in packages/config/src/registry.ts`,
        ).toContain(service);
      }
    },
  );

  // The lists are the test's subject, so an empty one would pass every
  // assertion above while proving nothing. Pinning the counts makes a list
  // emptied by a bad refactor fail here rather than go quiet.
  it("checks a non-empty list on both sides", () => {
    expect(REQUIRED_GITHUB_APP_ENV.length).toBe(6);
    expect(GITHUB_TOKEN_DECRYPT_ENV.length).toBe(3);
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
