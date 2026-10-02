/**
 * Stella can do what a person can do in the app, and nothing the app retired.
 *
 * An app action is a contract whose `layers` include `"app"`: a person runs it
 * from a page. Stella reaches a contract only when its `surfaces` include
 * `"agent"`, because the belt (`packages/agent/src/runtime/toolbelt.ts`)
 * denies every other. #4180 found 147 app actions off the agent surface with
 * no recorded reason, and 42 actions `DEREGISTERED.md` retires still on it.
 *
 * So every app action is on the agent surface or has a one-line reason in
 * `OFF_AGENT`. Every action `DEREGISTERED.md` lists is off the agent surface,
 * except the ones in `RETIRED_KEPT`, each held on by an open issue. The test
 * reads the retired set from `DEREGISTERED.md` itself, so a row added there is
 * checked here with no edit to this file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCapability, listCapabilities } from "../registry";
import { getSurfaces, type CapabilityDeclaration } from "../types";
import "../contracts.generated";

/**
 * App actions that stay off the agent surface, each with the reason.
 *
 * An entry needs a reason a reviewer can check against the contract. The
 * reasons so far: the call hands out or takes a secret, only a person's
 * browser can take the step, the call is the person's own say over Stella's
 * turn, or it would let an agent see what is withheld from it, touch how
 * people sign in, or change how its own work is graded.
 */
const OFF_AGENT: Readonly<Record<string, string>> = {
  answer_interjection:
    "An agent paused to ask a person this question, so the answer has to come from a person.",
  ask_assistant:
    "It starts a Stella turn, so Stella calling it would run a turn inside its own turn.",
  attach_github_installation:
    "A person picks the installation right after the browser GitHub sign-in that stored the token it checks.",
  authorize_cli:
    "It mints the code that gives the CLI an API key once the person consents in the browser, and it is on no surface.",
  authorize_issue_provider:
    "It finishes a browser sign-in with the code the provider sent back to the person.",
  authorize_mcp_server:
    "It finishes a browser sign-in with the code the MCP server sent back to the person.",
  authorize_slack_connection:
    "It finishes the Slack sign-in with the code Slack sent back to the person, and it is on no surface.",
  cancel_assistant_turn:
    "It is the person's stop control for a Stella turn. A turn that should stop ends by itself.",
  create_enrollment_token:
    "It returns a single-use enrollment secret, which would land in Stella's transcript.",
  create_scim_token:
    "It returns the SCIM bearer token once, which would land in Stella's transcript.",
  create_sso_provider:
    "Its input carries the OIDC client secret, which would land in Stella's transcript.",
  delete_model_credential:
    "Deleting the organization's key moves Stella's own turns onto the platform key, which Stella must not do.",
  delete_slack_connection:
    "It belongs to the Slack connection flow, which is on no surface.",
  delete_sso_provider:
    "Stella never changes how people sign in, and SSO settings decide that.",
  dismiss_finding:
    "A finding grades agents' runs, and the agent surface also serves registered agents, so an agent must not dismiss one.",
  dismiss_memories:
    "Mac ruled on 2026-09-25 that the in-app agent never receives workspace memories, so it neither reads nor dismisses them.",
  export_audit_events:
    "It returns a signed file of up to 50,000 events for a person to download and verify. Stella reads the same events through query_audit_log.",
  get_assistant_engine:
    "It probes Stella's own engine for the app's status badge. A turn that is running already has the answer.",
  get_assistant_reply:
    "The app reads a Stella turn's reply with it, and Stella wrote that reply.",
  get_slack_connection:
    "It belongs to the Slack connection flow, which is on no surface.",
  get_work_item:
    "It returns the issue's description and every source revision as collected, and the Phase 1 plan screens inbound content before any model reads it. This read does not screen.",
  get_work_outcomes:
    "Phase 1 keeps Work off the agent surface: every work decision refuses an agent run (assertWorkActor), and the item reads carry unscreened issue text. The outcome counts move with the other Work reads.",
  get_workspace_memory:
    "Mac ruled on 2026-09-25 that the in-app agent never receives workspace memories.",
  import_workspace_steering:
    "It moves a workspace's steering into a new repository and opens PRs on two repositories, a one-time move an owner starts from the setup dialog.",
  list_memory_pr_records:
    "It reads the memories a memory PR cites, and Mac ruled on 2026-09-25 that the in-app agent never receives workspace memories.",
  list_slack_channels:
    "It belongs to the Slack connection flow, which is on no surface.",
  list_sso_providers:
    "Stella never reads or changes how people sign in, and SSO settings decide that.",
  list_work_items:
    "It returns titles and requesters copied from GitHub issues, and the Phase 1 plan screens inbound content before any model reads it. This read does not screen.",
  list_work_targets:
    "It lists where a person can send work, and send_work_order refuses an agent run (assertWorkActor), so only a person's Send dialog uses it.",
  list_workspace_memories:
    "Mac ruled on 2026-09-25 that the in-app agent never receives workspace memories.",
  preview_skill_search:
    "It shows a person the skill names withheld from agents, and keeping them from an agent is what withholding is for.",
  promote_memories:
    "A person promotes a memory into a steering record, and Mac ruled on 2026-09-25 that the in-app agent never receives workspace memories.",
  record_reply_feedback:
    "It records the person's verdict on Stella's reply, so Stella must not write it.",
  register_agent:
    "It returns the new agent's long-lived credential once, which would land in Stella's transcript.",
  register_mcp_server:
    "Its input can carry the server's bearer token or auth headers, which would land in Stella's transcript.",
  resolve_approval:
    "It approves or denies a held call, so Stella could release the calls it was made to wait on.",
  revoke_scim_token:
    "Stella never changes how people sign in, and the SCIM token provisions them from the identity provider.",
  rotate_agent_credential:
    "It returns the replacement credential once, which would land in Stella's transcript.",
  rotate_scim_token:
    "It returns the new SCIM bearer token once, which would land in Stella's transcript.",
  set_agent_cache_keep_alive:
    "It decides whether the gateway spends tokens to keep an agent's prompt cache warm, and the team that owns the agent makes that call, so an agent must not change it.",
  set_model_credential:
    "Its input carries a model-vendor API key, which would land in Stella's transcript.",
  set_slack_channel:
    "It belongs to the Slack connection flow, which is on no surface.",
  set_sso_group_roles:
    "Stella never changes how people sign in, and SSO settings decide that.",
  set_sso_policy:
    "Stella never changes how people sign in, and SSO settings decide that.",
  start_issue_authorization:
    "It returns a sign-in URL for the person to open in a browser.",
  start_mcp_authorization:
    "It returns a sign-in URL for the person to open in a browser.",
  start_slack_connection:
    "It returns a Slack sign-in URL for the person to open in a browser, and it is on no surface.",
  update_sso_provider:
    "Its input can carry the OIDC client secret, which would land in Stella's transcript.",
  upload_assistant_attachment:
    "It stores a file the person attaches to a message. The file is the person's, not the model's.",
  verify_model_credential:
    "Its input can carry a candidate API key, which would land in Stella's transcript.",
  verify_sso_domain:
    "Stella never changes how people sign in, and SSO settings decide that.",
};

/**
 * Retired actions that stay on the agent surface until an open issue turns
 * them back on for good. Remove an entry when its issue closes either way.
 */
const RETIRED_KEPT: Readonly<Record<string, string>> = {
  get_pr: "#4178 merges pull requests through Stella",
  get_pr_diff: "#4178 merges pull requests through Stella",
  get_ci_status: "#4178 merges pull requests through Stella",
};

const DEREGISTERED_MD = fileURLToPath(
  new URL("../../../../DEREGISTERED.md", import.meta.url),
);

/** A register row: "| `install_plugin` | `plugin.org.install` | …". */
const RETIRED_ROW = /^\| `([a-z_]+)` \| `[a-z_.]+` \|/gm;

/** The registered names `DEREGISTERED.md` retires. */
function retiredNames(markdown: string): ReadonlySet<string> {
  return new Set(
    [...markdown.matchAll(RETIRED_ROW)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    ),
  );
}

const onAgent = (cap: CapabilityDeclaration): boolean =>
  getSurfaces(cap).includes("agent");

const isAppAction = (cap: CapabilityDeclaration): boolean =>
  cap.layers.includes("app");

/** App actions that are neither on the agent surface nor given a reason. */
function unreasonedOffAgent(
  caps: readonly CapabilityDeclaration[],
  retired: ReadonlySet<string>,
  reasons: Readonly<Record<string, string>>,
): string[] {
  return caps
    .filter(isAppAction)
    .filter((cap) => !onAgent(cap))
    .filter((cap) => !retired.has(cap.name))
    .filter((cap) => !Object.hasOwn(reasons, cap.name))
    .map((cap) => cap.name)
    .sort();
}

/** Retired actions still on the agent surface without a named exception. */
function retiredOnAgent(
  caps: readonly CapabilityDeclaration[],
  retired: ReadonlySet<string>,
  kept: Readonly<Record<string, string>>,
): string[] {
  return caps
    .filter((cap) => retired.has(cap.name))
    .filter((cap) => !Object.hasOwn(kept, cap.name))
    .filter(onAgent)
    .map((cap) => cap.name)
    .sort();
}

const RETIRED = retiredNames(readFileSync(DEREGISTERED_MD, "utf8"));

const contract = (
  name: string,
  overrides: Partial<CapabilityDeclaration>,
): CapabilityDeclaration => ({
  name,
  domain: "test",
  description: "test capability",
  mode: "sync",
  layers: ["unit", "app"],
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z.object({}),
  output: z.object({}),
  ...overrides,
});

describe("Stella has the app's actions", () => {
  it("every app action is on the agent surface or has a reason", () => {
    expect(
      unreasonedOffAgent(listCapabilities(), RETIRED, OFF_AGENT),
      'Add "agent" to these contracts\' surfaces, with `mutates` and an ' +
        "`agent` block sized to the risk, or add each name to OFF_AGENT " +
        "with the reason it stays off.",
    ).toEqual([]);
  });

  it("every reason names a registered app action that is off the agent surface", () => {
    for (const name of Object.keys(OFF_AGENT)) {
      const cap = getCapability(name);
      expect(cap, `${name} is registered`).toBeDefined();
      if (!cap) continue;
      expect(isAppAction(cap), `${name} is an app action`).toBe(true);
      expect(onAgent(cap), `${name} is off the agent surface`).toBe(false);
      expect(RETIRED.has(name), `${name} is not retired`).toBe(false);
    }
  });
});

describe("Stella has none of the retired actions", () => {
  it("reads the retired set from DEREGISTERED.md", () => {
    // One row from each of the register's tables, so a change to the row
    // shape fails here instead of emptying the set.
    for (const name of [
      "install_plugin",
      "create_environment",
      "get_prompt_settings",
      "import_env_secrets",
      "get_pr",
      "upload_asset",
      "get_connection",
    ]) {
      expect(RETIRED.has(name), `${name} is read as retired`).toBe(true);
    }
  });

  it("no retired action is on the agent surface", () => {
    expect(
      retiredOnAgent(listCapabilities(), RETIRED, RETIRED_KEPT),
      'Remove "agent" from these contracts\' surfaces. DEREGISTERED.md ' +
        "retires them.",
    ).toEqual([]);
  });

  it("every kept exception is a retired action still on the agent surface", () => {
    for (const name of Object.keys(RETIRED_KEPT)) {
      const cap = getCapability(name);
      expect(cap, `${name} is registered`).toBeDefined();
      expect(RETIRED.has(name), `${name} is retired`).toBe(true);
      if (cap) expect(onAgent(cap), `${name} is on the agent surface`).toBe(true);
    }
  });
});

describe("the parity checks", () => {
  it("report an app action off the agent surface with no reason", () => {
    const caps = [
      contract("app_off", { surfaces: ["api", "mcp"] }),
      contract("app_on", { surfaces: ["api", "agent"] }),
      contract("app_reasoned", { surfaces: ["api"] }),
      contract("app_retired", { surfaces: ["api"] }),
      contract("not_app", { surfaces: ["api"], layers: ["unit"] }),
    ];
    expect(
      unreasonedOffAgent(caps, new Set(["app_retired"]), {
        app_reasoned: "a reason",
      }),
    ).toEqual(["app_off"]);
  });

  it("report a retired action on the agent surface unless it is kept", () => {
    const caps = [
      contract("retired_on", { surfaces: ["api", "agent"] }),
      contract("retired_kept", { surfaces: ["agent"] }),
      contract("retired_off", { surfaces: ["api"] }),
      contract("live_on", { surfaces: ["agent"] }),
    ];
    const retired = new Set(["retired_on", "retired_kept", "retired_off"]);
    expect(
      retiredOnAgent(caps, retired, { retired_kept: "an issue" }),
    ).toEqual(["retired_on"]);
  });

  it("parse a register row and skip a path row", () => {
    const markdown = [
      "| `install_plugin` | `plugin.org.install` | CHAM | Install one plugin |",
      "| `get_connection` | `connection.get` | CH_M | `list_sources` |",
      "| `packages/plugins/src/vault/` | Secret storage |",
    ].join("\n");
    expect([...retiredNames(markdown)].sort()).toEqual([
      "get_connection",
      "install_plugin",
    ]);
  });
});
