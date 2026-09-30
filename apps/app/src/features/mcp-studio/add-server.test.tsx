// @vitest-environment jsdom
// Add server's Studio sources (#4678, items 1 to 3), as the Tools page's Add
// a provider dialog renders them through client.ts.
//
//   - From a definition checks the form, saves the new server's draft at
//     revision 0, then opens Review in the same submit. When Review refuses
//     after the save, the dialog names the refusal and a retry saves again at
//     the revision the save returned. It never starts over at revision 0.
//   - Local command and the registry package form render disabled, each with
//     the note naming the work that enables it.
//   - Discovery progress reads the server's discovery until it finishes,
//     through get_studio_discovery and start_studio_discovery for the page's
//     workspace.
//
// Each test fakes the calls and checks what the dialog shows and sends. axe
// checks the state each test ends in (INV-26).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryServer } from "@/data/contracts/tools";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import {
  DefinitionFields,
  DiscoveryProgress,
  LocalCommandFields,
  RegistryOfferChip,
  RegistryPackageFields,
} from "./add-server";
import type {
  CreateStudioServer,
  NewStudioServer,
  SavedStudioServer,
} from "./review-calls";
import type { StudioAt } from "./route";
import type {
  getStudioDiscovery,
  RegistryPackage,
  StudioDiscovery,
  startStudioDiscovery,
} from "./studio-calls";
import { fakeOpen, STUDIO_AT, studioReview } from "./studio.builders";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// With no calls passed, From a definition calls these server actions
// (review-calls.ts), and every test here passes its own. Discovery progress
// with no calls passed reads the server's discovery through its action, which
// answers "none yet" unless a test says otherwise.
const actions = vi.hoisted(() => ({
  saveStudioDraftAction: vi.fn(),
  saveNewStudioServerAction: vi.fn(),
  getStudioDraftAction: vi.fn(),
  openStudioReviewAction: vi.fn(),
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

const tDefinition = translator("mcpStudio.addServer.definition");
const tProblem = translator("mcpStudio.addServer.definition.problems");
const tLocal = translator("mcpStudio.addServer.local");
const tPackage = translator("mcpStudio.addServer.package");
const tOffer = translator("mcpStudio.addServer.offer");
const tDiscovery = translator("mcpStudio.addServer.discovery");
const tPr = translator("mcpStudio.changes.pr");

const OPENAPI = '{"openapi":"3.1.0","info":{"title":"Billing","version":"1"}}';

function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

function inputOf(label: string): HTMLInputElement {
  const node = screen.getByLabelText(label);
  if (!(node instanceof HTMLInputElement)) throw new Error(`no ${label} input`);
  return node;
}

function selectOf(label: string): HTMLSelectElement {
  const node = screen.getByLabelText(label);
  if (!(node instanceof HTMLSelectElement)) throw new Error(`no ${label} select`);
  return node;
}

// ---- From a definition -----------------------------------------------------

type CreateAnswer = Awaited<ReturnType<CreateStudioServer>>;

/**
 * A create call that gives its answers in turn, repeating the last, and
 * records what it was sent. With no answers it rejects, as a call that threw
 * before Oxagen answered.
 */
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

function renderDefinition(
  create: CreateStudioServer,
  review: ReturnType<typeof fakeOpen>["open"],
) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <DefinitionFields at={STUDIO_AT} calls={{ create, review }} />
    </IntlProvider>,
  );
  return user;
}

/** Fills every text field with a server the contract accepts. */
async function fillServer(
  user: ReturnType<typeof userEvent.setup>,
  over: Partial<Record<"name" | "label" | "description" | "url", string>> = {},
) {
  const values = {
    name: "billing",
    label: "Billing",
    description: "Invoices and refunds for the billing team.",
    url: "https://billing.example.com/v1",
    ...over,
  };
  await user.type(inputOf("Folder name"), values.name);
  await user.type(inputOf("Display name"), values.label);
  await user.type(inputOf("Description"), values.description);
  await user.type(inputOf("Production URL"), values.url);
}

async function upload(
  user: ReturnType<typeof userEvent.setup>,
  ...files: File[]
) {
  await user.upload(inputOf("Definition files"), files);
}

function jsonFile(name: string, text: string = OPENAPI): File {
  return new File([text], name, { type: "application/json" });
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("studio-add-definition-submit"));
}

const BILLING_TOML = [
  'schema = "mcp-server/v1"',
  'name = "billing"',
  'label = "Billing"',
  'description = "Invoices and refunds for the billing team."',
  "",
  "[source]",
  'type = "openapi"',
  'from = "upload"',
  "",
  "[auth]",
  'mode = "none"',
  "",
  "[environments.production]",
  'url = "https://billing.example.com/v1"',
  "",
  "[exposure]",
  'mode = "direct"',
  "",
  "[sync]",
  'schedule = "manual"',
  "",
].join("\n");

describe("From a definition", () => {
  it("saves at revision 0, opens Review, and links the steering PR with discovery progress", async () => {
    const { create, calls } = fakeCreate({
      ok: true,
      serverId: null,
      revision: 1,
    });
    const { open, calls: opens } = fakeOpen({
      ok: true,
      review: studioReview(),
    });
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    const opened = await screen.findByTestId("studio-add-definition-opened");
    const link = within(opened).getByRole("link", {
      name: tDefinition("opened", { number: "4721" }),
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/steering/pull/4721",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(calls).toStrictEqual([
      {
        input: {
          server: "billing",
          serverToml: BILLING_TOML,
          source: {
            type: "openapi",
            files: [{ path: "openapi.json", text: OPENAPI }],
            entry: "openapi.json",
          },
        },
        saved: null,
      },
    ]);
    expect(opens).toStrictEqual([{ server: "billing", revision: 1 }]);
    // The new server's discovery is read for the page's workspace.
    expect(
      await within(opened).findByTestId("studio-discovery-none"),
    ).toHaveTextContent(tDiscovery("none"));
    expect(actions.getStudioDiscoveryAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      "billing",
    );
    expect(
      within(opened).queryByTestId("studio-discovery-start"),
    ).not.toBeInTheDocument();
  });

  it("names Review's refusal after a save, and the retry saves at the returned revision", async () => {
    const { create, calls } = fakeCreate(
      { ok: true, serverId: null, revision: 1 },
      { ok: true, serverId: null, revision: 2 },
    );
    const { open, calls: opens } = fakeOpen(
      { ok: false, reason: "failed", code: "tools_unclassified" },
      { ok: true, review: studioReview() },
    );
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    const failed = await screen.findByTestId("studio-add-definition-failed");
    expect(failed).toHaveTextContent(tPr("codes.tools_unclassified"));
    // The saved draft keeps its folder name, so the retry saves over it.
    expect(inputOf("Folder name")).toHaveAttribute("readonly");
    const button = screen.getByTestId("studio-add-definition-submit");
    expect(button).toHaveTextContent(tDefinition("retry"));
    expect(button).toHaveAttribute("data-retry", "true");
    expect(calls[0]?.saved).toBeNull();
    expect(opens).toStrictEqual([{ server: "billing", revision: 1 }]);

    await submit(user);
    await screen.findByTestId("studio-add-definition-opened");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.saved).toStrictEqual({ serverId: null, revision: 1 });
    expect(calls[1]?.input.server).toBe("billing");
    expect(opens).toStrictEqual([
      { server: "billing", revision: 1 },
      { server: "billing", revision: 2 },
    ]);
    expect(
      screen.getByRole("link", {
        name: tDefinition("opened", { number: "4721" }),
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("studio-discovery-none"),
    ).toBeInTheDocument();
  });

  it("keeps a registered server's id for the retry", async () => {
    const { create, calls } = fakeCreate(
      { ok: true, serverId: "mcs_01k5s3", revision: 4 },
      { ok: true, serverId: "mcs_01k5s3", revision: 5 },
    );
    const { open, calls: opens } = fakeOpen(
      { ok: false, reason: "failed", code: "denied" },
      { ok: true, review: studioReview() },
    );
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);
    expect(
      await screen.findByTestId("studio-add-definition-failed"),
    ).toHaveTextContent(tPr("codes.denied"));

    await submit(user);
    await screen.findByTestId("studio-add-definition-opened");
    expect(calls[1]?.saved).toStrictEqual({
      serverId: "mcs_01k5s3",
      revision: 4,
    });
    expect(opens[1]).toStrictEqual({ server: "billing", revision: 5 });
  });

  it("names every problem and saves nothing", async () => {
    const { create, calls } = fakeCreate();
    const { open, calls: opens } = fakeOpen();
    const user = renderDefinition(create, open);
    await submit(user);

    const problems = await screen.findByTestId(
      "studio-add-definition-problems",
    );
    expect(
      within(problems)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toStrictEqual([
      tProblem("name"),
      tProblem("label"),
      tProblem("description"),
      tProblem("url"),
      tProblem("files"),
    ]);
    expect(calls).toHaveLength(0);
    expect(opens).toHaveLength(0);
    expect(
      screen.getByTestId("studio-add-definition-submit"),
    ).toHaveTextContent(tDefinition("submit"));
  });

  it("names a file that is not UTF-8 text and an empty one", async () => {
    const { create, calls } = fakeCreate();
    const { open } = fakeOpen();
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(
      user,
      new File([new Uint8Array([0xff, 0xfe, 0xfd])], "bad.json"),
      jsonFile("empty.json", "  \n"),
    );
    await submit(user);

    const problems = await screen.findByTestId(
      "studio-add-definition-problems",
    );
    expect(
      within(problems)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toStrictEqual([
      tProblem("unreadable", { file: "bad.json" }),
      tProblem("empty", { file: "empty.json" }),
    ]);
    expect(calls).toHaveLength(0);
  });

  it("sends the root document the person picks from the uploaded files", async () => {
    const { create, calls } = fakeCreate({
      ok: true,
      serverId: null,
      revision: 1,
    });
    const { open } = fakeOpen({ ok: true, review: studioReview() });
    const user = renderDefinition(create, open);
    await fillServer(user);
    const schemas = new File(["components: {}\n"], "schemas.yaml");
    const root = new File(["openapi: 3.1.0\n"], "root.yaml");
    await upload(user, schemas, root);

    const entry = selectOf("Root document");
    expect(entry.value).toBe("schemas.yaml");
    expect(
      Array.from(entry.options).map((option) => option.value),
    ).toStrictEqual(["schemas.yaml", "root.yaml"]);
    await user.selectOptions(entry, "root.yaml");
    await user.selectOptions(selectOf("Sync"), "daily");
    await submit(user);

    await screen.findByTestId("studio-add-definition-opened");
    expect(calls[0]?.input.source).toStrictEqual({
      type: "openapi",
      files: [
        { path: "schemas.yaml", text: "components: {}\n" },
        { path: "root.yaml", text: "openapi: 3.1.0\n" },
      ],
      entry: "root.yaml",
    });
    expect(calls[0]?.input.serverToml).toContain('schedule = "daily"');
  });

  it("sends a GraphQL schema as its SDL", async () => {
    const { create, calls } = fakeCreate({
      ok: true,
      serverId: null,
      revision: 1,
    });
    const { open } = fakeOpen({ ok: true, review: studioReview() });
    const user = renderDefinition(create, open);
    await fillServer(user);
    await user.selectOptions(selectOf("Definition type"), "graphql");
    expect(inputOf("Definition files").multiple).toBe(false);
    await upload(user, new File(["type Query { ok: Boolean }\n"], "schema.graphql"));
    // Only an OpenAPI definition has a root document.
    expect(screen.queryByLabelText("Root document")).not.toBeInTheDocument();
    await submit(user);

    await screen.findByTestId("studio-add-definition-opened");
    expect(calls[0]?.input.source).toStrictEqual({
      type: "graphql",
      sdl: "type Query { ok: Boolean }\n",
    });
    expect(calls[0]?.input.serverToml).toContain('type = "graphql"');
  });

  it("stores gRPC files under proto/", async () => {
    const { create, calls } = fakeCreate({
      ok: true,
      serverId: null,
      revision: 1,
    });
    const { open } = fakeOpen({ ok: true, review: studioReview() });
    const user = renderDefinition(create, open);
    await fillServer(user);
    await user.selectOptions(selectOf("Definition type"), "grpc");
    await upload(
      user,
      new File(['syntax = "proto3";\n'], "billing.proto"),
      new File(['syntax = "proto3";\n'], "types.proto"),
    );
    await submit(user);

    await screen.findByTestId("studio-add-definition-opened");
    expect(calls[0]?.input.source).toStrictEqual({
      type: "grpc",
      files: [
        { path: "proto/billing.proto", text: 'syntax = "proto3";\n' },
        { path: "proto/types.proto", text: 'syntax = "proto3";\n' },
      ],
    });
  });

  it("says a draft of that name exists and keeps the folder name editable", async () => {
    const { create } = fakeCreate({ ok: false, reason: "exists" });
    const { open, calls: opens } = fakeOpen();
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    expect(
      await screen.findByTestId("studio-add-definition-exists"),
    ).toHaveTextContent(tDefinition("exists", { name: "billing" }));
    expect(opens).toHaveLength(0);
    expect(inputOf("Folder name")).not.toHaveAttribute("readonly");
    expect(
      screen.getByTestId("studio-add-definition-submit"),
    ).not.toHaveAttribute("data-retry");
  });

  it("says someone saved the draft when Review finds it moved", async () => {
    const { create } = fakeCreate({ ok: true, serverId: null, revision: 1 });
    const { open } = fakeOpen({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    expect(
      await screen.findByTestId("studio-add-definition-moved"),
    ).toHaveTextContent(tDefinition("moved", { name: "billing" }));
  });

  it("shows an unknown code as itself, then says the retry found the draft moved", async () => {
    const { create, calls } = fakeCreate(
      { ok: true, serverId: null, revision: 1 },
      { ok: false, reason: "moved" },
    );
    const { open, calls: opens } = fakeOpen({
      ok: false,
      reason: "failed",
      code: "weird_code",
    });
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);
    expect(
      await screen.findByTestId("studio-add-definition-failed"),
    ).toHaveTextContent(tPr("failed", { code: "weird_code" }));

    await submit(user);
    expect(
      await screen.findByTestId("studio-add-definition-moved"),
    ).toHaveTextContent(tDefinition("moved", { name: "billing" }));
    expect(calls[1]?.saved).toStrictEqual({ serverId: null, revision: 1 });
    expect(opens).toHaveLength(1);
  });

  it.each([
    ["too_large", tDefinition("tooLarge")],
    ["server_toml_invalid", tDefinition("tomlInvalid")],
    ["source_invalid", tDefinition("sourceInvalid")],
    ["denied", tPr("codes.denied")],
  ])("names a %s save refusal in this page's words", async (code, text) => {
    const { create } = fakeCreate({ ok: false, reason: "failed", code });
    const { open, calls: opens } = fakeOpen();
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    expect(
      await screen.findByTestId("studio-add-definition-failed"),
    ).toHaveTextContent(text);
    expect(opens).toHaveLength(0);
    // Nothing was saved, so the next submit is a first save again.
    expect(
      screen.getByTestId("studio-add-definition-submit"),
    ).toHaveTextContent(tDefinition("submit"));
  });

  it("says the request failed when the save throws", async () => {
    const { create } = fakeCreate();
    const { open } = fakeOpen();
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    expect(
      await screen.findByTestId("studio-add-definition-failed"),
    ).toHaveTextContent(tPr("thrown"));
  });

  it("keeps the saved draft for a retry when Review throws", async () => {
    const { create } = fakeCreate({ ok: true, serverId: null, revision: 3 });
    const { open } = fakeOpen();
    const user = renderDefinition(create, open);
    await fillServer(user);
    await upload(user, jsonFile("openapi.json"));
    await submit(user);

    expect(
      await screen.findByTestId("studio-add-definition-failed"),
    ).toHaveTextContent(tPr("thrown"));
    expect(
      screen.getByTestId("studio-add-definition-submit"),
    ).toHaveAttribute("data-retry", "true");
  });
});

// ---- Local command -----------------------------------------------------------

describe("Local command", () => {
  it("renders disabled, with the note naming #4756 and no capability", () => {
    render(
      <IntlProvider>
        <LocalCommandFields />
      </IntlProvider>,
    );
    expect(inputOf("Command")).toBeDisabled();
    expect(screen.getByLabelText("Arguments")).toBeDisabled();
    expect(screen.getByLabelText("Machine groups")).toBeDisabled();
    const button = screen.getByTestId("studio-add-local-submit");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(tLocal("submit"));
    expect(button).toHaveAccessibleDescription(tLocal("pending"));
    const note = screen.getByTestId("studio-add-local-pending");
    expect(note).toHaveAttribute("data-gap", "#4756");
    expect(note).toHaveAttribute("data-state", "not-available");
    expect(note).not.toHaveAttribute("data-capability");
  });
});

// ---- Registry offer and package ----------------------------------------------

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

describe("RegistryOfferChip", () => {
  it.each([
    [
      "remote",
      registryServer({
        endpointUrl: "https://mcp.acme.example/mcp",
        transports: ["streamable-http"],
      }),
    ],
    ["package", registryServer()],
    [
      "both",
      registryServer({
        endpointUrl: "https://mcp.acme.example/mcp",
        transports: ["streamable-http", "stdio"],
      }),
    ],
  ] as const)("says the entry offers %s", (offer, server) => {
    const { container } = render(
      <IntlProvider>
        <RegistryOfferChip server={server} />
      </IntlProvider>,
    );
    const chip = element(container.querySelector("[data-offer]"), "chip");
    expect(chip).toHaveAttribute("data-offer", offer);
    expect(chip).toHaveTextContent(tOffer(offer));
  });

  it("renders nothing for an entry with neither", () => {
    const { container } = render(
      <IntlProvider>
        <RegistryOfferChip server={registryServer({ transports: ["sse"] })} />
      </IntlProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

const FILES_PACKAGES: readonly RegistryPackage[] = [
  {
    registryType: "mcpb",
    identifier: "https://acme.example/files.mcpb",
    version: "1.2.0",
    transport: "stdio",
    runtimeHint: null,
    packageArguments: [],
    environmentVariables: [],
  },
  {
    registryType: "pypi",
    identifier: "acme-files-mcp",
    version: "1.2.0",
    transport: "stdio",
    runtimeHint: "uvx",
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
      {
        type: "named",
        name: "--verbose",
        valueHint: null,
        isRequired: false,
        isSecret: false,
        value: null,
        default: null,
      },
    ],
    environmentVariables: [
      { name: "ACME_FILES_TOKEN", isRequired: true },
      { name: "ACME_FILES_DEBUG", isRequired: false },
    ],
  },
];

describe("RegistryPackageFields", () => {
  it("renders disabled with no arguments for an entry that lists no package, and names #4756", () => {
    render(
      <IntlProvider>
        <RegistryPackageFields server={registryServer()} />
      </IntlProvider>,
    );
    expect(screen.getByLabelText("Machine groups")).toBeDisabled();
    const type = selectOf("Package type");
    expect(type).toBeDisabled();
    expect(type.value).toBe("npm");
    expect(Array.from(type.options).map((option) => option.value)).toStrictEqual(
      ["npm", "pypi", "oci", "nuget"],
    );
    expect(
      screen.queryByTestId("studio-add-package-arguments"),
    ).not.toBeInTheDocument();
    const button = screen.getByTestId("studio-add-package-submit");
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(tPackage("pending"));
    const note = screen.getByTestId("studio-add-package-pending");
    expect(note).toHaveAttribute("data-gap", "#4756");
    expect(note).not.toHaveAttribute("data-capability");
  });

  it("reads the packages search_mcp_registry lists when the page passes none", () => {
    render(
      <IntlProvider>
        <RegistryPackageFields
          server={registryServer({ packages: [...FILES_PACKAGES] })}
        />
      </IntlProvider>,
    );
    expect(selectOf("Package type").value).toBe("pypi");
    const group = screen.getByRole("group", { name: tPackage("arguments") });
    expect(within(group).getByLabelText("--root")).toHaveValue("/srv/files");
  });

  it("asks for the required arguments of the first package the gateway runs", () => {
    render(
      <IntlProvider>
        <RegistryPackageFields
          server={registryServer()}
          packages={FILES_PACKAGES}
        />
      </IntlProvider>,
    );
    // mcpb is not a type the local gateway runs, so pypi is the first.
    expect(selectOf("Package type").value).toBe("pypi");
    const group = screen.getByRole("group", { name: tPackage("arguments") });
    expect(within(group).getByLabelText("--root")).toHaveValue("/srv/files");
    const token = within(group).getByLabelText("api_token");
    expect(token).toHaveValue("");
    expect(token).toHaveAccessibleDescription(tPackage("secretHint"));
    // A fixed value is the registry's, and an optional argument is not asked.
    expect(within(group).queryByLabelText("--mode")).not.toBeInTheDocument();
    expect(within(group).queryByLabelText("--verbose")).not.toBeInTheDocument();
    const variables = screen.getByRole("list", { name: tPackage("variables") });
    expect(
      within(variables)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toStrictEqual(["ACME_FILES_TOKEN"]);
    expect(screen.getByTestId("studio-add-package-submit")).toBeDisabled();
  });
});

// ---- Discovery progress --------------------------------------------------------

type GetDiscovery = typeof getStudioDiscovery;
type StartDiscovery = typeof startStudioDiscovery;
type GetAnswer = Awaited<ReturnType<GetDiscovery["call"]>>;
type StartAnswer = Awaited<ReturnType<StartDiscovery["call"]>>;

/** Gives its answers in turn, repeating the last, and records each input. */
function answering<O>(answers: readonly O[]) {
  const calls: { server: string }[] = [];
  const call = (_at: StudioAt, input: { server: string }): Promise<O> => {
    calls.push(input);
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    return answer === undefined
      ? Promise.reject(new Error("the fake discovery has no answer"))
      : Promise.resolve(answer);
  };
  return { call, calls };
}

/** get_studio_discovery, giving its answers in turn. */
function fakeGetDiscovery(...answers: GetAnswer[]) {
  const { call, calls } = answering(answers);
  const get: GetDiscovery = { name: "get_studio_discovery", call };
  return { get, calls };
}

/** start_studio_discovery, giving its answers in turn. */
function fakeStartDiscovery(...answers: StartAnswer[]) {
  const { call, calls } = answering(answers);
  const start: StartDiscovery = { name: "start_studio_discovery", call };
  return { start, calls };
}

function discoveryOf(over: Partial<StudioDiscovery> = {}): StudioDiscovery {
  return {
    id: "3f1c2b9a-0d4e-4c8b-9a7f-1e2d3c4b5a69",
    server: "billing",
    mcpServerId: "mcs_01k5s3",
    status: "succeeded",
    stalled: false,
    trigger: "lock_merged",
    requestedAt: "2026-09-29T18:00:00.000Z",
    requestedBy: null,
    startedAt: "2026-09-29T18:00:05.000Z",
    finishedAt: "2026-09-29T18:00:30.000Z",
    error: null,
    outcome: "pr_opened",
    toolCount: 3,
    machine: null,
    sourceKind: "openapi",
    sourceRepo: null,
    sourcePath: null,
    sourceRef: null,
    schedule: "manual",
    upstreamDigest: null,
    latestVersion: null,
    pr: {
      number: 4730,
      url: "https://github.com/acme/steering/pull/4730",
      branch: "oxagen/sync/billing",
    },
    withheld: [],
    ...over,
  };
}

const QUEUED = discoveryOf({
  status: "queued",
  startedAt: null,
  finishedAt: null,
  outcome: null,
  toolCount: null,
  pr: null,
});

describe("DiscoveryProgress", () => {
  it("reads through get_studio_discovery for the page's workspace when no call is passed", async () => {
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart />
      </IntlProvider>,
    );
    expect(
      await screen.findByTestId("studio-discovery-none"),
    ).toHaveTextContent(tDiscovery("none"));
    expect(actions.getStudioDiscoveryAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      "billing",
    );
    const start = screen.getByTestId("studio-discovery-start");
    expect(start).toBeEnabled();
    expect(start).toHaveAttribute("data-capability", "start_studio_discovery");
  });

  it("follows a queued discovery until it finishes", async () => {
    const { get, calls } = fakeGetDiscovery(
      { ok: true, discovery: QUEUED },
      { ok: true, discovery: discoveryOf() },
    );
    render(
      <IntlProvider>
        <DiscoveryProgress
          at={STUDIO_AT}
          server="billing"
          canStart={false}
          get={get}
          pollMs={50}
        />
      </IntlProvider>,
    );
    expect(
      await screen.findByTestId("studio-discovery-status"),
    ).toHaveTextContent(tDiscovery("statuses.queued"));
    await waitFor(() => {
      expect(screen.getByTestId("studio-discovery-status")).toHaveTextContent(
        tDiscovery("statuses.succeeded"),
      );
    });
    const section = screen.getByTestId("studio-discovery");
    expect(section).toHaveAttribute("data-status", "succeeded");
    // The plural comes from the catalogue's ICU message.
    expect(screen.getByTestId("studio-discovery-tools")).toHaveTextContent(
      "3 tools listed",
    );
    expect(screen.getByTestId("studio-discovery-outcome")).toHaveTextContent(
      tDiscovery("outcomes.pr_opened"),
    );
    const link = within(screen.getByTestId("studio-discovery-pr")).getByRole(
      "link",
      { name: tDiscovery("pr", { number: "4730" }) },
    );
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/steering/pull/4730",
    );
    expect(calls).toStrictEqual([{ server: "billing" }, { server: "billing" }]);
    expect(
      screen.queryByTestId("studio-discovery-start"),
    ).not.toBeInTheDocument();
  });

  it("stops reading once the section unmounts", async () => {
    const { get, calls } = fakeGetDiscovery({ ok: true, discovery: QUEUED });
    const { unmount } = render(
      <IntlProvider>
        <DiscoveryProgress
          at={STUDIO_AT}
          server="billing"
          canStart={false}
          get={get}
          pollMs={20}
        />
      </IntlProvider>,
    );
    await screen.findByTestId("studio-discovery-status");
    const read = calls.length;
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(read);
  });

  it("shows a stalled discovery, one tool, and never the handler's error text", async () => {
    const { get } = fakeGetDiscovery({
      ok: true,
      discovery: discoveryOf({
        status: "failed",
        stalled: true,
        outcome: null,
        toolCount: 1,
        pr: null,
        error: "upstream refused the handshake",
      }),
    });
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart={false} get={get} />
      </IntlProvider>,
    );
    expect(
      await screen.findByTestId("studio-discovery-status"),
    ).toHaveTextContent(tDiscovery("statuses.failed"));
    expect(screen.getByTestId("studio-discovery-tools")).toHaveTextContent(
      "1 tool listed",
    );
    expect(screen.getByTestId("studio-discovery-stalled")).toHaveTextContent(
      tDiscovery("stalled"),
    );
    expect(
      screen.queryByTestId("studio-discovery-outcome"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("studio-discovery-pr")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/upstream refused the handshake/),
    ).not.toBeInTheDocument();
  });

  it("says discovery has not run for a server with none", async () => {
    const { get } = fakeGetDiscovery({ ok: true, discovery: null });
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart={false} get={get} />
      </IntlProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      tDiscovery("loading"),
    );
    expect(
      await screen.findByTestId("studio-discovery-none"),
    ).toHaveTextContent(tDiscovery("none"));
  });

  it.each([
    [
      "a refusal's code",
      { ok: false, reason: "failed", code: "denied" },
      tDiscovery("failed", { code: "denied" }),
    ],
  ] as const)("names %s when the read is refused", async (_what, answer, text) => {
    const { get } = fakeGetDiscovery(answer);
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart={false} get={get} />
      </IntlProvider>,
    );
    expect(
      await screen.findByTestId("studio-discovery-failed"),
    ).toHaveTextContent(text);
  });

  it("says the request failed when the read throws", async () => {
    const { get } = fakeGetDiscovery();
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart={false} get={get} />
      </IntlProvider>,
    );
    expect(
      await screen.findByTestId("studio-discovery-failed"),
    ).toHaveTextContent(tDiscovery("thrown"));
  });

  it("says discovery starts once the folder merges when the server has no name", () => {
    const { get, calls } = fakeGetDiscovery({ ok: true, discovery: null });
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server={null} canStart get={get} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("studio-discovery-unnamed")).toHaveTextContent(
      tDiscovery("unnamed"),
    );
    expect(
      screen.queryByTestId("studio-discovery-start"),
    ).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("starts a discovery and reads it again", async () => {
    const { get, calls: reads } = fakeGetDiscovery(
      { ok: true, discovery: null },
      { ok: true, discovery: discoveryOf() },
    );
    const { start, calls: starts } = fakeStartDiscovery({
      ok: true,
      discovery: QUEUED,
    });
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart start={start} get={get} />
      </IntlProvider>,
    );
    await screen.findByTestId("studio-discovery-none");
    const button = screen.getByTestId("studio-discovery-start");
    expect(button).toHaveTextContent(tDiscovery("start"));
    expect(button).not.toHaveAccessibleDescription();
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("studio-discovery-status")).toHaveTextContent(
        tDiscovery("statuses.succeeded"),
      );
    });
    expect(starts).toStrictEqual([{ server: "billing" }]);
    expect(reads).toHaveLength(2);
  });

  it.each([
    [
      "refused",
      [{ ok: false, reason: "failed", code: "denied" }],
      tDiscovery("failed", { code: "denied" }),
    ],
    ["thrown", [], tDiscovery("thrown")],
  ] as const)("names a start that was %s", async (_what, answers, text) => {
    const { get } = fakeGetDiscovery({ ok: true, discovery: null });
    const { start } = fakeStartDiscovery(...answers);
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart start={start} get={get} />
      </IntlProvider>,
    );
    await screen.findByTestId("studio-discovery-none");
    await user.click(screen.getByTestId("studio-discovery-start"));
    expect(
      await screen.findByTestId("studio-discovery-failed"),
    ).toHaveTextContent(text);
  });

  it("starts through start_studio_discovery for the page's workspace when no start is passed", async () => {
    const { get } = fakeGetDiscovery(
      { ok: true, discovery: null },
      { ok: true, discovery: QUEUED },
    );
    actions.startStudioDiscoveryAction.mockResolvedValueOnce({
      ok: true,
      value: { discovery: QUEUED },
    });
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <DiscoveryProgress at={STUDIO_AT} server="billing" canStart get={get} pollMs={60_000} />
      </IntlProvider>,
    );
    await screen.findByTestId("studio-discovery-none");
    await user.click(screen.getByTestId("studio-discovery-start"));
    expect(
      await screen.findByTestId("studio-discovery-status"),
    ).toHaveTextContent(tDiscovery("statuses.queued"));
    expect(actions.startStudioDiscoveryAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      "billing",
    );
  });
});
