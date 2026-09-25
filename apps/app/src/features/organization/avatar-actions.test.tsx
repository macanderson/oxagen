// @vitest-environment jsdom
// Edit avatar on the Organization page: the organization's own, from the
// header, through update_org_settings, and a workspace's, from its row,
// through update_workspace_settings. Both open the shared avatar editor on the
// stored value, write the avatar alone, and reload the page on success.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { workspaceRow } from "./organization.builders";

const setOrgAvatar = vi.fn();
const setWorkspaceAvatar = vi.fn();
vi.mock("./actions", () => ({ setOrgAvatar, setWorkspaceAvatar }));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const { EditOrganizationAvatar, EditWorkspaceAvatar } = await import(
  "./avatar-actions"
);

const GOLD_ICON = 'avatar:v1:{"kind":"icon","icon":"rocket","tone":"gold"}';

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  refresh.mockReset();
  setOrgAvatar.mockReset();
  setWorkspaceAvatar.mockReset();
  setOrgAvatar.mockResolvedValue({ ok: true, value: { avatarUrl: "x" } });
  setWorkspaceAvatar.mockResolvedValue({ ok: true, value: { avatarUrl: "x" } });
});
afterEach(cleanup);

describe("the organization's avatar", () => {
  async function open(value: string | null = null) {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <EditOrganizationAvatar org="acme" name="Acme Robotics" value={value} />
      </IntlProvider>,
    );
    await user.click(screen.getByTestId("edit-org-avatar"));
    const dialog = await screen.findByTestId("edit-org-avatar-dialog");
    return { user, dialog };
  }

  it("opens the editor for the organization, as a squircle titled with its name", async () => {
    const { dialog } = await open();
    expect(screen.getByTestId("edit-org-avatar")).toHaveTextContent(
      "Edit avatar",
    );
    expect(dialog).toHaveTextContent("Avatar for Acme Robotics");
    expect(dialog).toHaveTextContent("acme");
    expect(within(dialog).getByTestId("avatar-preview").dataset.shape).toBe(
      "agent",
    );
    expect(within(dialog).getByTestId("avatar-letters")).toHaveValue("AR");
  });

  it("writes a gold avatar through update_org_settings and reloads", async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByTestId("avatar-kind-icon"));
    await user.click(within(dialog).getByTestId("avatar-icon-rocket"));
    await user.click(within(dialog).getByTestId("avatar-tone-gold"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(setOrgAvatar).toHaveBeenCalledWith("acme", GOLD_ICON);
    await waitFor(() => {
      expect(screen.queryByTestId("edit-org-avatar-dialog")).toBeNull();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("opens on the stored avatar and can clear it", async () => {
    const { user, dialog } = await open(GOLD_ICON);
    expect(within(dialog).getByTestId("avatar-tone-gold")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(dialog).getByTestId("avatar-remove"));
    expect(setOrgAvatar).toHaveBeenCalledWith("acme", "");
  });

  it("stays open and says so when the write is refused (negative)", async () => {
    setOrgAvatar.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const { user } = await open();
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-denied")).toHaveTextContent(
      "You do not have permission to change this organization.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { dialog } = await open(GOLD_ICON);
    await expectNoAxe(dialog);
  });
});

describe("a workspace's avatar", () => {
  it("writes through update_workspace_settings for that workspace", async () => {
    const user = userEvent.setup();
    const workspace = workspaceRow({
      avatarUrl: "https://cdn.example/core.png",
    });
    render(
      <IntlProvider>
        <EditWorkspaceAvatar org="acme" workspace={workspace} />
      </IntlProvider>,
    );
    await user.click(
      screen.getByTestId(`edit-workspace-avatar-${workspace.id}`),
    );
    const dialog = await screen.findByTestId(
      `edit-workspace-avatar-${workspace.id}-dialog`,
    );
    expect(dialog).toHaveTextContent("Avatar for Core platform");
    expect(within(dialog).getByTestId("avatar-url")).toHaveValue(
      "https://cdn.example/core.png",
    );
    await user.click(within(dialog).getByTestId("avatar-kind-initials"));
    await user.click(within(dialog).getByTestId("avatar-tone-gold-deep"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(setWorkspaceAvatar).toHaveBeenCalledWith(
      "acme",
      workspace.id,
      'avatar:v1:{"kind":"initials","text":"CP","font":"sans","tone":"gold-deep"}',
    );
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});
