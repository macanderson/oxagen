/**
 * The MCP Studio live test (lane M17, #5139).
 *
 * It runs against production Oxagen and the steering live test's GitHub test
 * organization, from `.github/workflows/mcp-studio-live.yml` only.
 * `playwright.mcp-studio-live.config.ts` holds its settings, and no unit,
 * integration, or e2e lane picks it up.
 *
 * The workflow starts the sample servers (`mcp-studio-servers.ts`) and a
 * public tunnel to them before the suite runs. The tests run in order in one
 * worker and share the run's workspace. As in the steering live test, no
 * test keeps state in the module that a later test needs: each one reads
 * what it needs back from Oxagen or from the sample servers' control port.
 *
 * Every steering PR the suite opens merges through the proposal row its opener
 * wrote (#5122), the agent file PR the host's enrollment opened among them
 * (#5149).
 */
import { expect, test } from "@playwright/test";
import {
  callsTo,
  control,
  createRelay,
  describeCheckRun,
  describeRelay,
  draftOps,
  enrollHost,
  gateway,
  type Gateway,
  hostRuntime,
  listApprovals,
  mergeSteeringPullRequest,
  openPolicyPr,
  openReview,
  publishAgentFile,
  readDraft,
  readStudioSettings,
  revokeRelay,
  saveDraft,
  servedName,
  serverFor,
  SERVERS,
  serverToml,
  setUpstreamCredential,
  startDiscovery,
  type StudioSettings,
  studioSource,
  textOf,
  waitForDiscovery,
  waitForRelay,
  waitForSteeringCheck,
  withSteeringCheckReport,
} from "./mcp-studio-rig";
import {
  createWorkspace,
  describeRepo,
  githubRig,
  type GithubRig,
  MINUTE,
  type Oxagen,
  poll,
  reached,
  readSteeringRepo,
  SECOND,
  signIn,
  waitForHealth,
  waitForProvisioned,
  waiting,
} from "./steering-rig";

/** The tool the Cedar policy forbids the test agent (`policyMarkdown` in the rig). */
const FORBIDDEN_TOOL = "live_mcp__create_issue";
/** The MCP tool whose description the sync test changes upstream. */
const SYNCED_TOOL = "list_repositories";
const CHANGED_DESCRIPTION = "List the repositories you can read. The MCP Studio live test changed this text.";

interface Rig {
  settings: StudioSettings;
  ox: Oxagen;
  gh: GithubRig;
}

let current: Promise<Rig> | undefined;

/** Signs in once per worker. A new worker signs in again. */
function rig(): Promise<Rig> {
  current ??= (async () => {
    const settings = readStudioSettings();
    return { settings, ox: await signIn(settings), gh: githubRig(settings.githubToken) };
  })();
  return current;
}

let agent: Promise<Gateway> | undefined;

/**
 * The enrolled test agent's gateway client, once per worker. Every enrollment
 * names the same host, so it binds the runtime the agent file names.
 */
function agentGateway(r: Rig): Promise<Gateway> {
  agent ??= enrollHost(r.ox, r.settings).then((host) => gateway(r.settings, host.gatewayKey));
  return agent;
}

/** The run's steering repo full name, once provisioning has created it. */
async function steeringRepoName(r: Rig): Promise<string> {
  const view = await readSteeringRepo(r.ox, r.settings);
  if (view.repository === null) {
    throw new Error(`Workspace ${r.settings.runSlug} has no steering repo: ${describeRepo(view)}.`);
  }
  return view.repository.fullName;
}

/** The steering PR a server folder's draft opened, or an error that names the folder. */
async function reviewPr(r: Rig, folder: string): Promise<number> {
  const read = await readDraft(r.ox, r.settings, folder);
  const pr = read.draft?.pr ?? null;
  if (pr === null) {
    throw new Error(`Server folder ${folder} has no steering PR. The import test opens it, so read that test's error first.`);
  }
  return pr.number;
}

/** Merges a steering PR through Oxagen once its check passed and the rig approved it. */
async function mergeThroughOxagen(r: Rig, fullName: string, number: number): Promise<void> {
  const pull = await r.gh.getPr(fullName, number);
  const check = await waitForSteeringCheck(r.gh, fullName, pull.head.sha);
  expect(check.conclusion, `PR #${String(number)}: ${describeCheckRun(pull.head.sha, check)}`).toBe("success");
  await r.gh.approvePr(fullName, number);

  const before = await readSteeringRepo(r.ox, r.settings);
  if (before.publishedVersion === null) {
    throw new Error(`The steering repo reads no published version before PR #${String(number)} merges: ${describeRepo(before)}.`);
  }
  const beforeVersion = before.publishedVersion;
  try {
    await mergeSteeringPullRequest(r.ox, r.settings, { number, headSha: pull.head.sha });
  } catch (error) {
    // A checks_failed refusal points at the check report on the test
    // repository, which cleanup deletes. The error carries the report.
    throw await withSteeringCheckReport(error, r.gh, fullName, number, [pull.head.sha]);
  }
  expect((await r.gh.getPr(fullName, number)).merged).toBe(true);
  await poll(
    `published version above ${String(beforeVersion)} after PR #${String(number)}`,
    { timeoutMs: 3 * MINUTE, intervalMs: 5 * SECOND },
    async () => {
      const view = await readSteeringRepo(r.ox, r.settings);
      return view.publishedVersion !== null && view.publishedVersion > beforeVersion
        ? reached(view)
        : waiting(describeRepo(view));
    },
  );
}

test("a new workspace is ready for MCP Studio, with a credential, a relay, and an enrolled host", async () => {
  const r = await rig();

  const created = await createWorkspace(r.ox, r.settings);
  expect(created.slug).toBe(r.settings.runSlug);
  await waitForProvisioned(r.ox, r.settings);

  const credential = await setUpstreamCredential(r.ox, r.settings);
  expect(credential.reference).toBe("oxagen:credential/mcp-live-upstream");

  // Enrollment binds the runtime the agent file names, and answers the public
  // half of the key Oxagen signs policy bundles and relay calls with.
  const host = await enrollHost(r.ox, r.settings);
  expect(await hostRuntime(r.ox, r.settings)).not.toBe("");

  const relay = await createRelay(r.ox, r.settings);
  expect(relay.token).toMatch(/^oxr_/);
  const ctl = control(r.settings);
  await ctl.startRelay({ token: relay.token, workspace: created.publicId, trustedKeys: host.signingKeyPem });
  await waitForRelay(ctl, `relay ${r.settings.relayName} connected to the broker`, 2 * MINUTE, (e) => e.event === "ready");
});

test("Studio imports two tools from each server, classifies them, and opens a steering PR for each", async () => {
  const r = await rig();
  const ctl = control(r.settings);
  const { grpcPort } = await ctl.status();

  for (const server of SERVERS) {
    const listing = server.kind === "mcp" ? await ctl.listMcpTools() : null;
    // A save with no revision replaces any draft a failed attempt left.
    await saveDraft(r.ox, r.settings, {
      server: server.folder,
      serverToml: serverToml(server, r.settings, grpcPort),
      ops: draftOps(server),
      source: studioSource(server, listing),
    });
    const review = await openReview(r.ox, r.settings, server.folder);
    expect(review.branch).toBe(`tools/${server.folder}`);
    expect([...review.imported].sort()).toEqual(server.tools.map((t) => t.name).sort());
    const errors = review.findings.filter((f) => f.level === "error").map((f) => `${f.rule}: ${f.message}`);
    expect(errors, `tool check errors on ${server.folder}`).toEqual([]);
  }

  // The first steering PR runs the repository's first health read, as in
  // the steering live test.
  await waitForHealth(r.ox, r.settings, "healthy", 3 * MINUTE);
});

test("each steering PR merges through Oxagen and raises the published version", async () => {
  const r = await rig();
  const fullName = await steeringRepoName(r);
  for (const server of SERVERS) {
    await mergeThroughOxagen(r, fullName, await reviewPr(r, server.folder));
  }
});

test("the test agent and its Cedar policies are published", async () => {
  const r = await rig();
  const fullName = await steeringRepoName(r);

  // The policies name tools the earlier merges published. A policy that
  // names an unpublished tool fails to compile, and then every call is denied.
  const agentPr = await publishAgentFile(r.ox, r.settings, await hostRuntime(r.ox, r.settings));
  await mergeThroughOxagen(r, fullName, agentPr.number);

  const policyPr = await openPolicyPr(r.ox, r.settings);
  await mergeThroughOxagen(r, fullName, policyPr.number);
});

test("an enrolled agent gets shaped results, an approval park, and a Cedar denial", async () => {
  const r = await rig();
  const gw = await agentGateway(r);
  const ctl = control(r.settings);

  const listed = new Map((await gw.listTools()).map((tool) => [tool.name, tool]));
  for (const server of SERVERS) {
    for (const tool of server.tools) {
      const name = servedName(server, tool);
      // A policy that forbids the agent every call to a tool also hides it.
      expect(listed.has(name), `${name} in the agent's tools/list`).toBe(name !== FORBIDDEN_TOOL);
    }
  }

  const reads: Array<[string, Record<string, unknown>, string]> = [
    ["live_mcp__list_repositories", {}, "billing-service"],
    ["live_payments__get_payment", { payment_id: "pay_live_1" }, "pay_live_1"],
    ["live_desk__issue", { number: 1 }, "The sample issue"],
    ["live_desk__create_issue", { input: { title: "Opened by the MCP Studio live test" } }, "Opened by the MCP Studio live test"],
    ["live_ledger__get_entry", { id: "ent_live_1" }, "ent_live_1"],
    ["live_ledger__post_entry", { accountId: "acct_live", kind: "ENTRY_KIND_CREDIT", manualNote: "posted by the live test" }, "acct_live"],
  ];
  for (const [name, args, expected] of reads) {
    const result = await gw.callTool(name, args);
    expect(result.isError ?? false, `${name}: ${textOf(result)}`).toBe(false);
    expect(JSON.stringify(result), `${name}'s shaped result`).toContain(expected);
  }

  // The irreversible tool parks for a person's approval and never reaches the upstream.
  const before = callsTo(await ctl.status(), "openapi", "POST /payments").length;
  const parked = await gw.callTool("live_payments__create_payment", {
    amount: 1250,
    currency: "USD",
    method: { type: "card", token: "tok_live_sample" },
  });
  expect(parked.isError, textOf(parked)).toBe(true);
  const approvalId = /Oxagen opened approval (apr_[0-9a-z]+)/.exec(textOf(parked))?.[1];
  expect(approvalId, `the approval id in: ${textOf(parked)}`).toBeDefined();
  const pending = await listApprovals(r.ox, r.settings);
  expect(pending.map((a) => a.id)).toContain(approvalId);

  // The Cedar policy denies the test agent create_issue, which also never reaches the upstream.
  const denied = await gw.callTool(FORBIDDEN_TOOL, { owner: "ox-product", repo: "sample", title: "Denied by policy" });
  expect(denied.isError, textOf(denied)).toBe(true);
  expect(textOf(denied)).toMatch(/denied/i);

  const after = await ctl.status();
  expect(callsTo(after, "openapi", "POST /payments")).toHaveLength(before);
  expect(callsTo(after, "mcp", "create_issue")).toHaveLength(0);
});

test("a changed description on the MCP server opens a sync PR, and agents keep the locked one", async () => {
  const r = await rig();
  const ctl = control(r.settings);
  const server = serverFor("live_mcp");
  const listing = await ctl.listMcpTools();
  const locked = listing.tools.find((t) => t.name === SYNCED_TOOL)?.description;
  expect(typeof locked).toBe("string");

  await ctl.setDescription(SYNCED_TOOL, CHANGED_DESCRIPTION);
  await startDiscovery(r.ox, r.settings, server.folder);
  const found = await waitForDiscovery(r.ox, r.settings, server.folder);
  expect(found.status, found.error ?? "").toBe("succeeded");
  expect(found.outcome).toBe("pr_opened");
  expect(found.pr?.branch ?? "").toMatch(/^tools\/sync-live_mcp-/);
  // A description change alone withholds nothing.
  expect(found.withheld).toEqual([]);

  // Until the sync steering PR merges, agents read the published lock's description.
  const gw = await agentGateway(r);
  const served = (await gw.listTools()).find((t) => t.name === `${server.folder}__${SYNCED_TOOL}`);
  expect(served?.description).toBe(locked);
  expect(served?.description).not.toBe(CHANGED_DESCRIPTION);
});

test("once the broker stops signing for the relay, the next call through it fails", async () => {
  const r = await rig();
  const ctl = control(r.settings);
  const gw = await agentGateway(r);
  const name = "live_ledger__get_entry";

  const ok = await gw.callTool(name, { id: "ent_live_2" });
  expect(ok.isError ?? false, textOf(ok)).toBe(false);

  // Revoking the relay is the one control Oxagen has that stops the broker
  // signing for one relay. The broker re-checks each connection's token
  // every 30 seconds and closes a revoked one with code 4001.
  await revokeRelay(r.ox, r.settings);
  await waitForRelay(
    ctl,
    `relay ${r.settings.relayName} closed after its revocation`,
    90 * SECOND,
    (e) => e.event === "token_revoked" || (e.event === "disconnected" && String(e.code) === "4001"),
  );

  const before = callsTo(await ctl.status(), "grpc", "GetEntry").length;
  const failed = await gw.callTool(name, { id: "ent_live_3" });
  expect(failed.isError, textOf(failed)).toBe(true);
  const status = await ctl.status();
  expect(callsTo(status, "grpc", "GetEntry"), describeRelay(status)).toHaveLength(before);
});

// The teardown archives the workspace, so a relay a failed run never revoked
// is left registered where nothing routes to it. Stopping its process here
// ends its connection before the job stops the sample servers.
test.afterAll(async () => {
  await control(readStudioSettings()).stopRelay();
});
