// @vitest-environment jsdom
// Add server's Local command and registry package forms (ADR-233, #4756), as
// the Tools page's Add a provider dialog renders them through client.ts. Both
// save the new server's server.toml, ask a machine to list its tools, show
// the listing until it finishes, then let the person import and classify the
// tools before Review opens the steering PR.
//
// Each test fakes the calls and checks what the dialog shows and sends. The
// listing polls every millisecond here, so a test waits on the screen rather
// than on a timer. axe checks the state each test ends in (INV-26).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryPackage, RegistryServer } from "@/data/contracts/tools";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { LocalCommandFields, RegistryPackageFields } from "./machine-fields";
import type {
  CreateStudioServer,
  NewStudioServer,
  SavedStudioServer,
} from "./review-calls";
import type { StudioAt } from "./route";
import type { StudioListing } from "./studio-calls";
import {
  fakeGet,
  fakeOpen,
  fakeSave,
  savedDraft,
  STUDIO_AT,
  studioReview,
} from "./studio.builders";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The opened step shows discovery progress, which reads through its action
// and answers "none yet".
const actions = vi.hoisted(() => ({
  getStudioDiscoveryAction: vi.fn(() =>
    Promise.resolve({ ok: true as const, value: { discovery: null } }),
  ),
  startStudioDiscoveryAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const tLocal = translator("mcpStudio.addServer.local");
const tPackage = translator("mcpStudio.addServer.package");
const tMachine = translator("mcpStudio.addServer.machine");
const tProblem = translator("mcpStudio.addServer.machine.problems");
const tListing = translator("mcpStudio.addServer.listing");
const tClassify = translator("mcpStudio.addServer.classify");
const tFields = translator("mcpStudio.addServer.fields");
const tRegistry = translator("tools.registry");

const HEX = "c3".repeat(32);

type Calls = NonNullable<ComponentProps<typeof LocalCommandFields>["calls"]>;
type ListingAnswer = Awaited<ReturnType<Calls["get"]["call"]>>;
type StartAnswer = Awaited<ReturnType<Calls["start"]["call"]>>;
type CreateAnswer = Awaited<ReturnType<CreateStudioServer>>;

/** A listing as get_studio_listing returns it, waiting for a machine. */
function listing(over: Partial<StudioListing> = {}): StudioListing {
  return {
    server: "notes",
    status: "waiting_for_machine",
    machineGroups: ["dev-laptops"],
    pin: {
      name: "notes-mcp",
      version: "0.9.2",
      digest: `sha256:${HEX}`,
      registryType: null,
    },
    draftRevision: 1,
    requestedAt: "2026-09-30T10:00:00.000Z",
    requestedBy: "user_1",
    claimedAt: null,
    finishedAt: null,
    machine: null,
    toolCount: null,
    error: null,
    tools: null,
    ...over,
  };
}

const LISTED = listing({
  status: "succeeded",
  claimedAt: "2026-09-30T10:00:05.000Z",
  finishedAt: "2026-09-30T10:00:09.000Z",
  machine: "tch_laptop01",
  toolCount: 2,
  tools: [
    {
      name: "list_notes",
      description: "Lists the notes on this machine.",
      suggested: { risk: "low", sideEffect: "read", egress: "local", impacts: [] },
    },
    {
      name: "delete_note",
      description: null,
      suggested: {
        risk: "high",
        sideEffect: "irreversible",
        egress: "local",
        impacts: ["destroys_data"],
      },
    },
  ],
});

/** Gives its answers in turn, repeating the last, and records each input. */
function inTurn<I, O>(answers: readonly O[]) {
  const calls: I[] = [];
  const call = (_at: StudioAt, input: I): Promise<O> => {
    calls.push(input);
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    return answer === undefined
      ? Promise.reject(new Error("the fake has no answer"))
      : Promise.resolve(answer);
  };
  return { call, calls };
}

function fakeCreate(...answers: CreateAnswer[]) {
  const calls: { input: NewStudioServer; saved: SavedStudioServer | null }[] =
    [];
  const create: CreateStudioServer = (input, saved) => {
    calls.push({ input, saved });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    return answer === undefined
      ? Promise.reject(new Error("the fake create has no answer"))
      : Promise.resolve(answer);
  };
  return { create, calls };
}

/** Every call the flow makes, answering the path where everything works. */
type ReadAnswer = Awaited<ReturnType<Calls["read"]>>;

function fakeCalls(
  over: {
    create?: CreateAnswer[];
    start?: StartAnswer[];
    get?: ListingAnswer[];
    read?: ReadAnswer[];
  } = {},
) {
  const create = fakeCreate(
    ...(over.create ?? [{ ok: true, serverId: null, revision: 1 }]),
  );
  const start = inTurn<Parameters<Calls["start"]["call"]>[1], StartAnswer>(
    over.start ?? [{ ok: true, listing: listing() }],
  );
  const get = inTurn<Parameters<Calls["get"]["call"]>[1], ListingAnswer>(
    over.get ?? [
      { ok: true, listing: listing() },
      { ok: true, listing: LISTED },
    ],
  );
  const read = fakeGet(
    ...(over.read ?? [
      {
        ok: true,
        draft: savedDraft({ server: "notes", serverId: null, revision: 2 }),
      },
    ]),
  );
  const save = fakeSave({
    ok: true,
    draft: savedDraft({ server: "notes", serverId: null, revision: 3 }),
  });
  const review = fakeOpen({
    ok: true,
    review: studioReview({ number: 4790, url: "https://github.com/acme/steering/pull/4790" }),
  });
  const calls: Calls = {
    create: create.create,
    start: { name: "start_studio_listing", call: start.call },
    get: { name: "get_studio_listing", call: get.call },
    read: read.get,
    save: save.save,
    review: review.open,
  };
  return { calls, create, start, get, read, save, review };
}

function renderLocal(calls: Calls) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <LocalCommandFields at={STUDIO_AT} calls={calls} pollMs={1} />
    </IntlProvider>,
  );
  return user;
}

async function fillLocal(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(tFields("name")), "notes");
  await user.type(screen.getByLabelText(tFields("label")), "Notes");
  await user.type(
    screen.getByLabelText(tFields("description")),
    "Notes kept on each machine.",
  );
  await user.type(
    screen.getByLabelText(tLocal("command")),
    "/usr/local/bin/notes-mcp",
  );
  await user.type(screen.getByLabelText(tLocal("machines")), "dev-laptops");
  await user.type(screen.getByLabelText(tLocal("version")), "0.9.2");
  await user.type(
    screen.getByLabelText(tLocal("digest")),
    `${HEX}  /usr/local/bin/notes-mcp`,
  );
}

describe("Local command", () => {
  it("saves the server, lists its tools on a machine, and opens Review with the tools the person picked", async () => {
    const fake = fakeCalls();
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));

    // The listing finishes, and each tool arrives picked with its suggestion.
    const rows = await screen.findAllByTestId("studio-add-classify-tool");
    // The first save is at revision 0, with server.toml alone.
    expect(fake.create.calls).toHaveLength(1);
    expect(fake.create.calls[0]?.saved).toBeNull();
    expect(fake.create.calls[0]?.input.source).toBeUndefined();
    expect(fake.create.calls[0]?.input.serverToml).toContain('type = "local"');
    // The listing is pinned on the revision the save returned.
    expect(fake.start.calls).toStrictEqual([
      {
        server: "notes",
        revision: 1,
        pin: { version: "0.9.2", digest: `sha256:${HEX}` },
      },
    ]);
    expect(rows.map((row) => row.dataset.tool)).toStrictEqual([
      "list_notes",
      "delete_note",
    ]);
    const second = rows[1];
    if (second === undefined) throw new Error("no second row");
    expect(
      within(second).getByRole("checkbox", {
        name: tClassify("import", { name: "delete_note" }),
      }),
    ).toBeChecked();
    expect(within(second).getByLabelText("Side effect")).toHaveValue(
      "irreversible",
    );

    // The person keeps list_notes, raises its risk, and leaves delete_note.
    const first = rows[0];
    if (first === undefined) throw new Error("no first row");
    await user.selectOptions(
      within(first).getByLabelText("Risk"),
      tRegistry("risk.medium"),
    );
    await user.click(
      within(second).getByRole("checkbox", {
        name: tClassify("import", { name: "delete_note" }),
      }),
    );
    await user.click(screen.getByTestId("studio-add-classify-submit"));
    const opened = await screen.findByTestId("studio-add-local-opened");

    // The edits are saved at the revision the listing left, then reviewed.
    expect(fake.read.calls).toStrictEqual([{ server: "notes" }]);
    expect(fake.save.calls).toStrictEqual([
      {
        server: "notes",
        ops: [
          { kind: "import", tool: "list_notes" },
          {
            kind: "classify",
            tool: "list_notes",
            risk: "medium",
            sideEffect: "read",
            egress: "local",
            impacts: [],
          },
        ],
        revision: 2,
      },
    ]);
    expect(fake.review.calls).toStrictEqual([{ server: "notes", revision: 3 }]);
    expect(
      within(opened).getByRole("link", {
        name: tMachine("opened", { number: "4790" }),
      }),
    ).toHaveAttribute("href", "https://github.com/acme/steering/pull/4790");
  });

  it("names every problem and saves nothing when the form is empty (negative)", async () => {
    const fake = fakeCalls();
    const user = renderLocal(fake.calls);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    const problems = await screen.findByTestId("studio-add-local-problems");
    expect(problems).toHaveTextContent(tProblem("name"));
    expect(problems).toHaveTextContent(tProblem("command"));
    expect(problems).toHaveTextContent(tProblem("machines"));
    expect(problems).toHaveTextContent(tProblem("digest"));
    expect(fake.create.calls).toHaveLength(0);
  });

  it("goes back to the form when no machine lists the tools, and saves over the same draft on the next submit (negative)", async () => {
    const fake = fakeCalls({
      create: [
        { ok: true, serverId: null, revision: 1 },
        { ok: true, serverId: null, revision: 2 },
      ],
      get: [{ ok: true, listing: listing({ status: "failed", error: "digest mismatch" }) }],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));

    const unlisted = await screen.findByTestId("studio-add-local-unlisted");
    expect(unlisted).toHaveTextContent(tMachine("unlisted"));
    // The handler's error text never reaches the page.
    expect(document.body).not.toHaveTextContent("digest mismatch");
    const submit = screen.getByTestId("studio-add-local-submit");
    expect(submit).toHaveAttribute("data-retry", "true");
    expect(submit).toHaveTextContent(tMachine("retry"));
    // A saved draft keeps its folder name.
    expect(screen.getByLabelText(tFields("name"))).toHaveAttribute("readonly");

    await user.click(submit);
    await waitFor(() => {
      expect(fake.start.calls).toHaveLength(2);
    });
    expect(fake.create.calls[1]?.saved).toStrictEqual({
      serverId: null,
      revision: 1,
    });
    // The fields kept what the person typed, and the pin is the same.
    expect(fake.start.calls[1]).toStrictEqual({
      server: "notes",
      revision: 2,
      pin: { version: "0.9.2", digest: `sha256:${HEX}` },
    });
  });

  it("names a saved draft that holds a definition, and saves nothing over it (negative)", async () => {
    const fake = fakeCalls({
      create: [{ ok: false, reason: "exists" }],
      read: [
        {
          ok: true,
          draft: savedDraft({
            server: "notes",
            serverId: null,
            revision: 2,
            source: { type: "openapi", bytes: 2048 },
          }),
        },
      ],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    expect(
      await screen.findByTestId("studio-add-local-exists"),
    ).toHaveTextContent(tMachine("exists", { name: "notes" }));
    expect(fake.create.calls).toHaveLength(1);
    expect(fake.start.calls).toHaveLength(0);
  });

  it("resumes the listing of a draft already saved under that folder name", async () => {
    const fake = fakeCalls({
      create: [{ ok: false, reason: "exists" }],
      get: [
        { ok: true, listing: listing() },
        { ok: true, listing: listing() },
        { ok: true, listing: LISTED },
      ],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));

    // The dialog picks up the stored listing instead of starting another.
    expect(
      await screen.findAllByTestId("studio-add-classify-tool"),
    ).toHaveLength(2);
    expect(fake.start.calls).toHaveLength(0);
    expect(fake.read.calls).toStrictEqual([{ server: "notes" }]);
  });

  it("offers to save over a saved draft with no tools listed, then lists it", async () => {
    const fake = fakeCalls({
      create: [
        { ok: false, reason: "exists" },
        { ok: true, serverId: null, revision: 3 },
      ],
      get: [{ ok: true, listing: null }, { ok: true, listing: listing() }],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    expect(
      await screen.findByTestId("studio-add-local-resumable"),
    ).toHaveTextContent(tMachine("resumable", { name: "notes" }));

    await user.click(screen.getByTestId("studio-add-local-submit"));
    await waitFor(() => {
      expect(fake.start.calls).toHaveLength(1);
    });
    // The second submit saves over the stored draft at its revision.
    expect(fake.create.calls[1]?.saved).toStrictEqual({
      serverId: null,
      revision: 2,
    });
    expect(fake.start.calls[0]?.revision).toBe(3);
  });

  it("names the refusal when the person enrolled no machine in the groups (negative)", async () => {
    const fake = fakeCalls({
      start: [{ ok: false, reason: "failed", code: "machine_not_yours" }],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    expect(
      await screen.findByTestId("studio-add-local-failed"),
    ).toHaveTextContent(tMachine("notYours"));
  });

  it("shows the listing while it waits for a machine in the server's groups", async () => {
    const fake = fakeCalls({ get: [{ ok: true, listing: listing() }] });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    const section = await screen.findByTestId("studio-listing");
    expect(section).toHaveAttribute("data-capability", "get_studio_listing");
    expect(
      await within(section).findByTestId("studio-listing-status"),
    ).toHaveTextContent(tListing("statuses.waiting_for_machine"));
    expect(within(section).getByTestId("studio-listing-waiting")).toHaveTextContent(
      tListing("waiting", { groups: "dev-laptops" }),
    );
    expect(within(section).getByTestId("studio-listing-pin")).toHaveTextContent(
      tListing("pin", { name: "notes-mcp", version: "0.9.2" }),
    );
  });

  it("names a draft someone saved while the person picked its tools, and saves over it on the next submit (negative)", async () => {
    const fake = fakeCalls();
    const conflict = fakeSave(
      { ok: false, reason: "conflict", code: "draft_revision_stale" },
      { ok: true, draft: savedDraft({ server: "notes", serverId: null, revision: 4 }) },
    );
    const user = renderLocal({ ...fake.calls, save: conflict.save });
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    await screen.findAllByTestId("studio-add-classify-tool");
    await user.click(screen.getByTestId("studio-add-classify-submit"));
    expect(
      await screen.findByTestId("studio-add-classify-moved"),
    ).toHaveTextContent(tClassify("moved", { name: "notes" }));
    expect(fake.review.calls).toHaveLength(0);

    await user.click(screen.getByTestId("studio-add-classify-submit"));
    await screen.findByTestId("studio-add-local-opened");
    // The second submit reads the draft again and reviews the new revision.
    expect(fake.read.calls).toHaveLength(2);
    expect(fake.review.calls).toStrictEqual([{ server: "notes", revision: 4 }]);
  });

  it("offers to read the listing again after a read fails (negative)", async () => {
    const fake = fakeCalls({
      get: [
        { ok: false, reason: "failed", code: "unavailable" },
        { ok: true, listing: LISTED },
      ],
    });
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    expect(
      await screen.findByTestId("studio-listing-failed"),
    ).toHaveTextContent(tListing("readFailed", { code: "unavailable" }));
    await user.click(screen.getByTestId("studio-listing-reread"));
    expect(
      await screen.findAllByTestId("studio-add-classify-tool"),
    ).toHaveLength(2);
    expect(fake.get.calls).toHaveLength(2);
  });

  it("refuses to open Review with no tool picked (negative)", async () => {
    const fake = fakeCalls();
    const user = renderLocal(fake.calls);
    await fillLocal(user);
    await user.click(screen.getByTestId("studio-add-local-submit"));
    const rows = await screen.findAllByTestId("studio-add-classify-tool");
    for (const row of rows) await user.click(within(row).getByRole("checkbox"));
    await user.click(screen.getByTestId("studio-add-classify-submit"));
    expect(
      await screen.findByTestId("studio-add-classify-none"),
    ).toHaveTextContent(tClassify("none"));
    expect(fake.save.calls).toHaveLength(0);
    expect(fake.review.calls).toHaveLength(0);
  });
});

// ---- Registry package -----------------------------------------------------------

function registryServer(over: Partial<RegistryServer> = {}): RegistryServer {
  return {
    registryRef: "io.github.acme/files",
    name: "Acme files",
    description: "Reads and writes files in a folder.",
    publisher: "github.com/acme",
    publisherVerified: false,
    source: "registry",
    version: "1.2.0",
    iconUrl: null,
    websiteUrl: null,
    docsUrl: null,
    repositoryUrl: "https://github.com/acme/files",
    endpointUrl: null,
    transports: ["stdio"],
    auth: "none",
    authHeader: null,
    oauthRegistration: null,
    connectable: false,
    packages: [],
    ...over,
  };
}

const NPM: RegistryPackage = {
  registryType: "npm",
  identifier: "@acme/files-mcp",
  version: "1.2.0",
  transport: "stdio",
  runtimeHint: "npx",
  packageArguments: [
    {
      type: "named",
      name: "--root",
      valueHint: null,
      isRequired: true,
      isSecret: false,
      value: null,
      default: "/srv/files",
    },
    {
      type: "positional",
      name: null,
      valueHint: "api_token",
      isRequired: true,
      isSecret: true,
      value: null,
      default: null,
    },
    {
      type: "named",
      name: "--mode",
      valueHint: null,
      isRequired: true,
      isSecret: false,
      value: "readonly",
      default: null,
    },
  ],
  environmentVariables: [
    { name: "ACME_FILES_TOKEN", isRequired: true },
    { name: "ACME_FILES_DEBUG", isRequired: false },
  ],
};

const PYPI: RegistryPackage = { ...NPM, registryType: "pypi", identifier: "acme-files-mcp" };
const OCI: RegistryPackage = { ...NPM, registryType: "oci", identifier: "ghcr.io/acme/files" };

function renderPackage(
  calls: Calls,
  packages: readonly RegistryPackage[],
  server = registryServer(),
) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <RegistryPackageFields
        at={STUDIO_AT}
        server={server}
        packages={packages}
        calls={calls}
        pollMs={1}
      />
    </IntlProvider>,
  );
  return user;
}

describe("RegistryPackageFields", () => {
  it("asks for the required arguments, reads a secret from the machine, and lists with no pin", async () => {
    const fake = fakeCalls({ get: [{ ok: true, listing: listing() }] });
    const user = renderPackage(fake.calls, [OCI, NPM]);

    // The catalog carries no OCI image digest, so npm is the only type offered.
    const type = screen.getByLabelText(tPackage("type"));
    expect(type).toHaveValue("npm");
    expect(within(type).getAllByRole("option")).toHaveLength(1);
    // The folder, display name and description start from the entry.
    expect(screen.getByLabelText(tFields("name"))).toHaveValue("files");
    expect(screen.getByLabelText(tFields("label"))).toHaveValue("Acme files");
    const group = screen.getByRole("group", { name: tPackage("arguments") });
    expect(within(group).getByLabelText("--root")).toHaveValue("/srv/files");
    // A secret takes no value in the form, and a fixed value is not asked.
    expect(within(group).queryByLabelText("api_token")).not.toBeInTheDocument();
    expect(within(group).getByTestId("studio-add-package-secret")).toHaveTextContent(
      tPackage("secretFrom", { name: "API_TOKEN" }),
    );
    expect(within(group).queryByLabelText("--mode")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(tLocal("machines")), "dev-laptops");
    await user.click(screen.getByTestId("studio-add-package-submit"));

    const toml = fake.create.calls[0]?.input.serverToml ?? "";
    expect(toml).toContain('server = "io.github.acme/files"');
    expect(toml).toContain('registry_type = "npm"');
    expect(toml).toContain('env = ["ACME_FILES_TOKEN", "API_TOKEN"]');
    expect(toml).toContain('"--root" = "/srv/files"');
    expect(toml).toContain('"api_token" = "${API_TOKEN}"');
    expect(await screen.findByTestId("studio-listing")).toBeVisible();
    expect(fake.start.calls).toStrictEqual([{ server: "files", revision: 1 }]);
  });

  it("names Oxagen's refusal to pin, and stays on the form (negative)", async () => {
    const fake = fakeCalls({
      start: [{ ok: false, reason: "failed", code: "registry_unreachable" }],
    });
    const user = renderPackage(fake.calls, [NPM]);
    await user.type(screen.getByLabelText(tLocal("machines")), "dev-laptops");
    await user.click(screen.getByTestId("studio-add-package-submit"));
    expect(
      await screen.findByTestId("studio-add-package-failed"),
    ).toHaveTextContent(tMachine("registryUnreachable"));
    expect(screen.queryByTestId("studio-listing")).not.toBeInTheDocument();
  });

  it("offers a PyPI package, which Oxagen pins to one file of its release (ADR-233)", async () => {
    const fake = fakeCalls({ get: [{ ok: true, listing: listing() }] });
    const user = renderPackage(fake.calls, [PYPI]);
    expect(screen.getByLabelText(tPackage("type"))).toHaveValue("pypi");
    await user.type(screen.getByLabelText(tLocal("machines")), "dev-laptops");
    await user.click(screen.getByTestId("studio-add-package-submit"));
    expect(fake.create.calls[0]?.input.serverToml).toContain('registry_type = "pypi"');
    expect(await screen.findByTestId("studio-listing")).toBeVisible();
    expect(fake.start.calls).toStrictEqual([{ server: "files", revision: 1 }]);
  });

  it("says Oxagen cannot pin an entry that offers only an OCI image (negative)", () => {
    const fake = fakeCalls();
    renderPackage(fake.calls, [OCI]);
    expect(
      screen.getByTestId("studio-add-package-unpinned"),
    ).toHaveTextContent(tPackage("unpinned", { types: "oci" }));
    expect(screen.queryByTestId("studio-add-package")).not.toBeInTheDocument();
  });

  it("offers no package whose transport is not stdio, which the local gateway does not run (negative)", () => {
    renderPackage(fakeCalls().calls, [{ ...NPM, transport: "streamable-http" }]);
    expect(
      screen.getByTestId("studio-add-package-unpinned"),
    ).toHaveTextContent(tPackage("unpinned", { types: "npm" }));
    expect(screen.queryByTestId("studio-add-package")).not.toBeInTheDocument();
  });

  it("says an entry with no package has nothing a machine can run (negative)", () => {
    renderPackage(fakeCalls().calls, []);
    expect(
      screen.getByTestId("studio-add-package-unpinned"),
    ).toHaveTextContent(tPackage("noPackage"));
  });
});
