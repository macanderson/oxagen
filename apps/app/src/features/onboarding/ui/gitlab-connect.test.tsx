// @vitest-environment jsdom
// The GitLab form on Connect a code host as an operator drives it: the post
// it sends, the continue to the first workspace on a 200, the sentence each
// refusal shows, and the token field cleared after every answer. Axe runs
// after every test.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const fetchGitlab = vi.fn<typeof fetch>();

const { GitlabConnect } = await import("./gitlab-connect");

const PATH = "/api/v1/acme/connections/steering/gitlab";
const NEXT = routes.welcomeFirstWorkspace("acme");

function renderForm() {
  render(
    <IntlProvider>
      <GitlabConnect path={PATH} next={NEXT} />
    </IntlProvider>,
  );
}

async function connect(group = " acme/platform ", token = "glpat-secret") {
  await userEvent.type(screen.getByLabelText("Group path"), group);
  await userEvent.type(screen.getByLabelText("Group access token"), token);
  await userEvent.click(screen.getByRole("button", { name: "Connect GitLab" }));
}

const refusal = (status: number, error: Record<string, string>) =>
  Response.json({ error, requestId: "req_01" }, { status });

beforeAll(() => {
  vi.stubGlobal("fetch", fetchGitlab);
});
beforeEach(() => {
  router.push.mockReset();
  fetchGitlab.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("GitlabConnect", () => {
  it("posts the trimmed group and the token, continues to the first workspace, and clears the token", async () => {
    fetchGitlab.mockResolvedValueOnce(
      Response.json({ group_id: 42, group_path: "acme/platform" }),
    );
    renderForm();
    expect(screen.getByLabelText("Group access token")).toHaveAttribute(
      "type",
      "password",
    );
    await connect();
    expect(fetchGitlab).toHaveBeenCalledTimes(1);
    const [url, init] = fetchGitlab.mock.calls[0] ?? [];
    expect(url).toBe(PATH);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    expect(init?.body).toBe(
      JSON.stringify({ group: "acme/platform", token: "glpat-secret" }),
    );
    expect(router.push).toHaveBeenCalledWith(NEXT);
    expect(screen.getByLabelText("Group access token")).toHaveValue("");
    expect(screen.queryByTestId("gitlab-connect-refused")).toBeNull();
  });

  it.each([
    [
      "gitlab_token_invalid",
      "GitLab did not accept the token. Create a new group access token and try again.",
    ],
    [
      "gitlab_group_unreachable",
      "GitLab found no group at that path that this token can reach. Check the group path.",
    ],
    [
      "gitlab_token_insufficient",
      "The token needs the api scope and the Maintainer role on the group.",
    ],
  ])(
    "names GitLab's refusal %s, keeps the form, and clears the token (negative)",
    async (reason, sentence) => {
      fetchGitlab.mockResolvedValueOnce(
        refusal(422, { code: "conflict", reason }),
      );
      renderForm();
      await connect();
      expect(
        await screen.findByTestId("gitlab-connect-refused"),
      ).toHaveTextContent(sentence);
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Group path")).toHaveValue(
        " acme/platform ",
      );
      expect(screen.getByLabelText("Group access token")).toHaveValue("");
    },
  );

  it("says the role cannot connect a host on a 403 (negative)", async () => {
    fetchGitlab.mockResolvedValueOnce(refusal(403, { code: "forbidden" }));
    renderForm();
    await connect();
    expect(
      await screen.findByTestId("gitlab-connect-refused"),
    ).toHaveTextContent(
      "Your role on this organization cannot connect a code host. An owner or admin can.",
    );
  });

  it("asks for both fields on a 400 (negative)", async () => {
    fetchGitlab.mockResolvedValueOnce(refusal(400, { code: "invalid_input" }));
    renderForm();
    await connect();
    expect(
      await screen.findByTestId("gitlab-connect-refused"),
    ).toHaveTextContent("Enter the group path and the token.");
  });

  it("names the code of any other failure, or its status when the body has none (negative)", async () => {
    fetchGitlab.mockResolvedValueOnce(refusal(502, { code: "gitlab_down" }));
    renderForm();
    await connect();
    expect(
      await screen.findByTestId("gitlab-connect-refused"),
    ).toHaveTextContent("GitLab did not connect (gitlab_down). Try again.");
    cleanup();

    fetchGitlab.mockResolvedValueOnce(
      new Response("upstream timed out", { status: 504 }),
    );
    renderForm();
    await connect();
    expect(
      await screen.findByTestId("gitlab-connect-refused"),
    ).toHaveTextContent("GitLab did not connect (504). Try again.");
  });

  it("says the request did not reach the server when fetch throws (negative)", async () => {
    fetchGitlab.mockRejectedValueOnce(new TypeError("offline"));
    renderForm();
    await connect();
    expect(
      await screen.findByTestId("gitlab-connect-refused"),
    ).toHaveTextContent("GitLab did not connect (network). Try again.");
    expect(screen.getByLabelText("Group access token")).toHaveValue("");
    expect(router.push).not.toHaveBeenCalled();
  });
});
