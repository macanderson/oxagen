// @vitest-environment jsdom
// The client shell hands the assistant flyout the person's `enter_to_submit`
// preference, read on the server into `data.viewer` (source.ts). The flyout's
// prop is optional, so the compiler does not hold this wiring. This does.
// Every other piece of the chrome is a stub: shell-client.test.tsx drives
// them, and assistant-flyout.enter-to-send.test.tsx drives the keys.
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { shellData } from "./shell.builders";

const AssistantFlyout = vi.hoisted(() =>
  vi.fn((_props: { enterToSubmit?: boolean }) => null),
);
vi.mock("./assistant-flyout", () => ({ AssistantFlyout }));
vi.mock("./account-dialog", () => ({ AccountDialog: () => null }));
vi.mock("./approvals-drawer", () => ({ ApprovalsDrawer: () => null }));
vi.mock("./avatar-dialog", () => ({ AvatarDialog: () => null }));
vi.mock("./card-tables", () => ({ useCardTables: () => undefined }));
vi.mock("./command-menu", () => ({ CommandMenu: () => null }));
vi.mock("./mobile-nav", () => ({
  NavDrawer: () => null,
  ShellMobileNav: () => null,
}));
vi.mock("./notifications-dialog", () => ({ NotificationsDialog: () => null }));
vi.mock("./shell-state", () => ({
  ShellStateProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("./topbar", () => ({ Topbar: () => null }));

const { ShellClient } = await import("./shell-client");

afterEach(cleanup);

describe("ShellClient", () => {
  it.each([true, false])(
    "hands the flyout enter_to_submit %s as the viewer's preference",
    async (enterToSubmit) => {
      const data = shellData();
      const { container } = render(
        <ShellClient
          data={{ ...data, viewer: { ...data.viewer, enterToSubmit } }}
        />,
      );

      expect(AssistantFlyout).toHaveBeenCalled();
      expect(AssistantFlyout.mock.lastCall?.[0]).toEqual({ enterToSubmit });
      await expectNoAxe(container);
    },
  );
});
