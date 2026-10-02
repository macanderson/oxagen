import type { Refresh } from "./registry";

// ─────────────────────────────────────────────────────────────────────────────
// Every GitHub Actions secret and variable a workflow reads, with how to
// refresh it (ADR-240). `ENV_REGISTRY` covers what the services read; this
// covers what CI reads. A name can appear in both: CI's copy is usually a test
// value, not production's.
//
// `pnpm env:check` reads `.github/` and fails when a workflow reads a
// `secrets.X` or `vars.X` this file does not list, or when this file lists one
// no workflow reads. `GITHUB_TOKEN` is GitHub's own and is not listed.
//
// Phase 3 of ADR-240 moves the secrets to `/oxagen/ci` in Parameter Store and
// reads them through the OIDC roles the workflows already assume. Until then
// they are repository secrets, saved with `gh secret set <NAME>`.
// ─────────────────────────────────────────────────────────────────────────────

/** `secrets.X` or `vars.X` in a workflow. */
export type CiValueKind = "secret" | "variable";

export interface CiVarMeta {
  kind: CiValueKind;
  /** What it is and which workflows read it. */
  description: string;
  /**
   * The GitHub environment that holds it, when it is an environment secret
   * rather than a repository secret.
   */
  environment?: string;
  refresh: Refresh;
}

export const CI_REGISTRY: Record<string, CiVarMeta> = {
  // ── Secrets ────────────────────────────────────────────────────────────────
  AI_GATEWAY_API_KEY: {
    kind: "secret",
    description:
      "Vercel AI Gateway key for CI's model calls: the nightly live-model checks, release notes in release.yml, and the vision gate.",
    refresh: {
      how: "Create a key in the Vercel dashboard under AI Gateway, API keys. Save it here, then delete the old key on the same page.",
    },
  },
  APPLE_CERTIFICATE: {
    kind: "secret",
    description:
      "Base64 of the Developer ID Application certificate and its private key, exported as a .p12. desktop.yml signs the macOS build with it. Unset, the build signs ad hoc.",
    refresh: {
      how: "Apple issues the certificate at developer.apple.com under Certificates. Export it with its private key from Keychain Access as a .p12, and save the base64 of the file. Save APPLE_CERTIFICATE_PASSWORD in the same change.",
      command: "base64 -i developer-id.p12",
    },
  },
  APPLE_CERTIFICATE_PASSWORD: {
    kind: "secret",
    description: "Export password of the .p12 in APPLE_CERTIFICATE.",
    refresh: {
      how: "You choose it when you export the .p12. Change it only with APPLE_CERTIFICATE.",
    },
  },
  APPLE_ID: {
    kind: "secret",
    description: "Apple ID email desktop.yml notarizes the macOS build with.",
    refresh: {
      how: "The email of the Apple developer account. It changes only when the account does.",
    },
  },
  APPLE_PASSWORD: {
    kind: "secret",
    description: "App-specific password for APPLE_ID, used by notarization in desktop.yml.",
    refresh: {
      how: "Generate one at account.apple.com under Sign-In and Security, App-Specific Passwords. Revoke the old one there after the next desktop build notarizes.",
    },
  },
  APPLE_SIGNING_IDENTITY: {
    kind: "secret",
    description:
      "Name of the Developer ID certificate desktop.yml signs with, as Keychain shows it.",
    refresh: {
      how: "Read it from the certificate in APPLE_CERTIFICATE. It changes when that certificate does.",
      command: "security find-identity -v -p codesigning",
    },
  },
  APPLE_TEAM_ID: {
    kind: "secret",
    description: "Apple developer team id, used by notarization in desktop.yml.",
    refresh: {
      how: "Read it at developer.apple.com under Membership details. It changes only with the team.",
    },
  },
  AUTH_TOKEN_ENCRYPTION_KEY: {
    kind: "secret",
    description:
      "CI's own key-encryption key for the app stack the test, e2e, nightly, mockup-parity, and Work walk jobs start. Not production's key.",
    refresh: {
      how: "Mint a random 32-byte key. CI seeds a fresh database each run, so any new value works at once.",
      command: "openssl rand -base64 32",
    },
  },
  FLEET_OPERATOR_TOKEN: {
    kind: "secret",
    description:
      "Staging operator credential the fleet load rig enrolls synthetic hosts with (fleet-capacity.yml). Never a production credential.",
    refresh: {
      how: "Issue an operator token from the staging deployment (ADR-150) for the fleet organization, save it here, then revoke the old one. docs/runbooks/fleet-capacity.md covers the rig.",
    },
  },
  LINEAR_ACCESS_KEY: {
    kind: "secret",
    description:
      "Access key of the Linear release pipeline linear-release.yml reports releases to. Not a lin_api_ personal key.",
    refresh: {
      how: "In Linear, open Settings, Releases, the pipeline, and regenerate its access key.",
    },
  },
  LINEAR_API_KEY: {
    kind: "secret",
    description:
      "Linear personal API key CI files and updates issues with (pipeline.yml, nightly.yml).",
    refresh: {
      how: "In Linear, open Settings, Security and access, Personal API keys. Create a key, save it here and in /oxagen/operator, then revoke the old one.",
    },
  },
  NPM_TOKEN: {
    kind: "secret",
    description:
      "npm token npm.yml publishes @oxagen/cli with, after every production deploy and every release tag. It expires within 90 days.",
    refresh: {
      how: "On npmjs.com, signed in as the account that owns @oxagen, open Access Tokens and generate a granular token with read and write on @oxagen/cli and the longest expiry npm allows (90 days). If the account requires two-factor authentication for writes, let the token bypass it. Save it with `gh secret set NPM_TOKEN`, which reads the value from a prompt. Dispatch npm.yml with no inputs, or wait for the next deploy, and check its run publishes or reports the version already on npm. Then delete the old token. Mac rotates it on a scheduled routine.",
    },
  },
  OPENROUTER_API_KEY: {
    kind: "secret",
    description: "OpenRouter inference key for the nightly live-model checks.",
    refresh: {
      how: "Create a key at openrouter.ai/settings/keys, or mint one with the management key, then delete the old key.",
      command:
        "curl -s https://openrouter.ai/api/v1/keys -H \"Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY\" -H 'Content-Type: application/json' -d '{\"name\":\"oxagen-ci\"}'",
    },
  },
  OXAGEN_CONTAINED_ANTHROPIC_API_KEY: {
    kind: "secret",
    description:
      "Anthropic key for the Claude Code session contained.yml runs under `tacho run --contained`.",
    refresh: {
      how: "Create a key at console.anthropic.com under API keys, in the workspace that bills CI. Disable the old key after the next contained run passes.",
    },
  },
  OXAGEN_CONTAINED_APP_PRIVATE_KEY: {
    kind: "secret",
    description:
      "Private key of the GitHub App (OXAGEN_CONTAINED_APP_ID) contained.yml acts as.",
    refresh: {
      how: "On the GitHub App's settings page, generate a private key and save the .pem. Delete the old key on the same page once the next run passes.",
    },
  },
  OXAGEN_CONTAINED_TOKEN: {
    kind: "secret",
    description:
      "Oxagen API token contained.yml enrolls its runner with, in the organization named by OXAGEN_ORG.",
    refresh: {
      how: "Create an API token in the production app for that organization, save it here, then revoke the old one.",
    },
  },
  PREVIEW_DATABASE_URL: {
    kind: "secret",
    description:
      "Postgres URL db-migrate.yml applies migrations to when dispatched with target preview.",
    refresh: {
      how: "Compose it from the preview database's endpoint, user, and password. Rotate the password on the database first, then save the new URL here.",
    },
  },
  RELEASE_TOKEN: {
    kind: "secret",
    description:
      "Fine-grained personal access token release.yml pushes the release commit and tag with. A push with GITHUB_TOKEN starts no workflow, so the release would not deploy.",
    refresh: {
      how: "At github.com/settings/personal-access-tokens, create a fine-grained token on this repository with contents, pull requests, and workflows write. Give it an expiry and replace it before that date.",
    },
  },
  ROADMAP_READ_TOKEN: {
    kind: "secret",
    description:
      "Token mockup-parity-capture.yml reads the page registry in the private roadmap repository with.",
    refresh: {
      how: "Create a fine-grained personal access token with contents read on the roadmap repository, save it here, then revoke the old one.",
    },
  },
  SCR_CORPUS_TOKEN: {
    kind: "secret",
    description:
      "Token scr-corpus-check.yml reads the other repositories with. Unset, it falls back to GITHUB_TOKEN, which sees only this repository.",
    refresh: {
      how: "Create a fine-grained personal access token with contents read on the repositories the check lists.",
    },
  },
  STEERING_LIVE_GITHUB_APP_PRIVATE_KEY: {
    kind: "secret",
    environment: "steering-live",
    description:
      "Private key of the rig GitHub App (STEERING_LIVE_GITHUB_APP_ID). steering-live.yml and mcp-studio-live.yml mint the rig's GitHub token with it.",
    refresh: {
      how: "On the rig App's settings page, generate a private key and save the .pem. Delete the old key once the next live run passes.",
    },
  },
  STEERING_LIVE_OXAGEN_EMAIL: {
    kind: "secret",
    environment: "steering-live",
    description:
      "Sign-in email of the Oxagen test account the steering live test and the MCP Studio live test use.",
    refresh: {
      how: "The test account's email. Change it only with STEERING_LIVE_OXAGEN_PASSWORD.",
    },
  },
  STEERING_LIVE_OXAGEN_PASSWORD: {
    kind: "secret",
    environment: "steering-live",
    description: "Password of the Oxagen test account the two live tests use.",
    refresh: {
      how: "Set a new password in the Oxagen app while signed in as the test account, then save it here.",
      command: "openssl rand -base64 24",
    },
  },
  STRIPE_SECRET_KEY: {
    kind: "secret",
    environment: "production",
    description:
      "Stripe key stripe-sync.yml writes prices and meters with. It is production's key: the shared sandbox until the live cutover (docs/ops/stripe-sandbox-mode.md).",
    refresh: {
      how: "In the Stripe dashboard, open Developers, API keys, and roll the secret key. Save it here and at /oxagen/production/STRIPE_SECRET_KEY in the same sitting, then redeploy.",
    },
  },
  STRIPE_TEST_SECRET_KEY: {
    kind: "secret",
    description:
      "Stripe sandbox key the e2e jobs pay with (pipeline.yml, nightly.yml, mockup-parity-capture.yml). A fork pull request runs without it, and pay.spec.ts skips.",
    refresh: {
      how: "In the Stripe sandbox, open Developers, API keys. Create a restricted key or roll the standard key.",
    },
  },
  TAURI_SIGNING_PRIVATE_KEY: {
    kind: "secret",
    description:
      "Minisign private key desktop.yml signs updater artifacts with. Installed apps check updates against the matching public key in apps/desktop/src-tauri/tauri.conf.json.",
    refresh: {
      how: "Rotate only on a leak. A new key needs a release, signed with the old key, that ships the new public key first, or installed apps reject every later update. Generate the pair, put the public key in tauri.conf.json, and save the private key here and at /oxagen/operator/TAURI_SIGNING_PRIVATE_KEY.",
      command:
        "pnpm --filter @oxagen/desktop exec tauri signer generate -w ~/.tauri/oxagen-desktop.key",
    },
  },
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: {
    kind: "secret",
    description:
      "Password of TAURI_SIGNING_PRIVATE_KEY. The key has none, so the secret holds the empty string.",
    refresh: {
      how: "Changes only with TAURI_SIGNING_PRIVATE_KEY. Keep it empty unless the new key has a password.",
    },
  },

  // ── Variables ──────────────────────────────────────────────────────────────
  CI_HEAVY_POOL: {
    kind: "variable",
    description:
      "The runner pool the heavy jobs use when CI_RUNNERS is aws: large (the default) or small (pipeline.yml, ADR-246).",
    refresh: {
      how: "A setting. Change it when the account's EC2 quota changes. docs/runbooks/ci-runners.md explains the pools.",
    },
  },
  CI_IMAGE_REGISTRY: {
    kind: "variable",
    description:
      "Registry the CI toolchain and service images come from, such as an ECR Public alias. Unset, jobs use the frozen GHCR images.",
    refresh: {
      how: "A setting. Point it at the registry ci-image.yml publishes to (docs/runbooks/ci-runners.md).",
    },
  },
  CI_RUNNER_ARCH: {
    kind: "variable",
    description:
      "CPU architecture of the self-hosted CI pools when CI_RUNNERS is aws: x64 (the default) or arm64.",
    refresh: { how: "A setting. Change it with the pools in infra/stacks-new/ci-runners." },
  },
  CI_RUNNERS: {
    kind: "variable",
    description:
      "Set to aws to run CI jobs on Oxagen's own runner pools (ADR-246). Any other value, or unset, runs them on GitHub-hosted runners.",
    refresh: {
      how: "A switch. Set it to github to move every job back to GitHub-hosted runners on its next run.",
    },
  },
  CI_SUPERSEDED_THRESHOLD: {
    kind: "variable",
    description:
      "How many superseded runs in a row make ci-superseded.yml report a pull request. Unset or below 2 reads as 3.",
    refresh: { how: "A setting. Change it with `gh variable set`." },
  },
  FLEET_BUNDLE_PUBLIC_KEY_PEM: {
    kind: "variable",
    description: "Pinned staging policy-bundle public key for the fleet load rig.",
    refresh: {
      how: "The public half of staging's TACHO_BUNDLE_SIGNING_PRIVATE_KEY. Derive it again whenever that key changes.",
      command: "openssl pkey -in tacho-bundle.pem -pubout",
    },
  },
  FLEET_OUTPUT_ROOT: {
    kind: "variable",
    description:
      "Private, persistent directory on the fleet runner for reports and credentials.",
    refresh: { how: "A path on the runner. Change it when the runner moves." },
  },
  FLEET_STAGING_ORIGIN: {
    kind: "variable",
    description: "Exact HTTPS origin of the staging deployment the fleet rig targets.",
    refresh: { how: "Staging's public origin. Change it when staging's domain does." },
  },
  LINEAR_PROJECT_ID: {
    kind: "variable",
    description:
      "Linear project CI files issues into. pipeline.yml and nightly.yml fall back to the oxagen-v2 project when unset.",
    refresh: { how: "Copy the id from the project's URL in Linear." },
  },
  OXAGEN_CONTAINED_APP_ID: {
    kind: "variable",
    description: "Numeric id of the GitHub App contained.yml acts as.",
    refresh: { how: "Read it on the App's settings page. It changes only with the App." },
  },
  OXAGEN_CONTAINED_ENABLED: {
    kind: "variable",
    description: "Set to true to run contained.yml's contained-run job against production.",
    refresh: { how: "A switch. Set it to true or delete it." },
  },
  OXAGEN_LLM_BALANCED: {
    kind: "variable",
    description:
      "Model release.yml writes release notes with. Unset, the script uses the registry's balanced tier.",
    refresh: { how: "A gateway model id. Change it to move release notes to another model." },
  },
  OXAGEN_ORG: {
    kind: "variable",
    description: "Oxagen organization slug contained.yml enrolls into.",
    refresh: { how: "The organization's slug in the production app." },
  },
  OXAGEN_WORKSPACE: {
    kind: "variable",
    description: "Oxagen workspace slug contained.yml records its run in.",
    refresh: { how: "The workspace's slug in the production app." },
  },
  STAGING_ENABLED: {
    kind: "variable",
    description:
      "Set to true to run the staging verification in pipeline.yml and gate production on it. Off while staging is dormant (#4868).",
    refresh: {
      how: "A switch. Turn it on only with `dormant = false` in infra/stacks-new/staging/main.tf.",
    },
  },
  STEERING_LIVE_ENABLED: {
    kind: "variable",
    description:
      "Set to true to run steering-live.yml and mcp-studio-live.yml on their schedules, not only by hand.",
    refresh: { how: "A switch. Set it to true or delete it." },
  },
  STEERING_LIVE_GITHUB_APP_ID: {
    kind: "variable",
    description:
      "Numeric id of the rig GitHub App. The app is installed on STEERING_LIVE_GITHUB_ORG, and steering-live.yml and mcp-studio-live.yml mint the rig's GitHub token from it.",
    refresh: {
      how: "Read it on the rig App's settings page. Change it only with STEERING_LIVE_GITHUB_APP_PRIVATE_KEY.",
    },
  },
  STEERING_LIVE_GITHUB_ORG: {
    kind: "variable",
    description:
      "The test GitHub organization the steering live test and the MCP Studio live test create repositories in.",
    refresh: { how: "The organization's login. It changes only with the organization." },
  },
  STEERING_LIVE_OXAGEN_ORG: {
    kind: "variable",
    description: "Oxagen organization slug the steering live test and the MCP Studio live test sign in to.",
    refresh: { how: "The test organization's slug in the Oxagen app." },
  },
};

/**
 * The command that saves a new value where CI reads it. Run it from a checkout:
 * `gh` takes the repository from the git remote, so the command survives a
 * move between owners. `gh secret set` prompts for the value, or reads it
 * from stdin.
 */
export function ciSaveCommand(name: string): string | undefined {
  const meta = CI_REGISTRY[name];
  if (!meta) return undefined;
  const env = meta.environment ? ` --env ${meta.environment}` : "";
  return meta.kind === "secret"
    ? `gh secret set ${name}${env}`
    : `gh variable set ${name}${env} --body '<value>'`;
}
