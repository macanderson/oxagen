// @vitest-environment jsdom
/**
 * sandbox-create-dialog.test.tsx
 *
 * Covers the new-sandbox flow: choosing a runtime, adding warm-time packages,
 * and forwarding the composed request (templateId + setupPackages) to
 * startSandboxAction, then reporting the new session id back to the parent.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const { startSandboxAction } = vi.hoisted(() => ({
  startSandboxAction: vi.fn(),
}));

vi.mock("./actions", () => ({ startSandboxAction }));
// The repo picker pulls heavy chat deps; stub it — repos aren't under test here.
vi.mock("@/components/sandbox/sandbox-repo-picker", () => ({
  SandboxRepoPicker: () => null,
  toSandboxRepoInputs: () => [],
}));

import { SandboxCreateDialog } from "./sandbox-create-dialog";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  startSandboxAction.mockResolvedValue({
    ok: true,
    sandbox: { sessionId: "sbx_new" },
  });
});

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "eng",
    canManage: true,
    unavailable: false,
    templates: [],
    repoOptions: [],
    onWarmed: vi.fn(),
  };
}

describe("SandboxCreateDialog", () => {
  it("warms a node sandbox with npm packages composed into setupPackages", async () => {
    const onWarmed = vi.fn();
    render(<SandboxCreateDialog {...baseProps()} onWarmed={onWarmed} />);

    // Pick the Node runtime — its primary manager is npm.
    fireEvent.click(screen.getByTestId("sandbox-runtime-node"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "node box" },
    });

    const pkgInput = screen.getByTestId("sandbox-create-pkg-input");
    fireEvent.change(pkgInput, { target: { value: "express" } });
    fireEvent.keyDown(pkgInput, { key: "Enter" });
    expect(screen.getByTestId("sandbox-create-pkg-chip").textContent).toContain(
      "express",
    );

    fireEvent.click(screen.getByTestId("sandbox-warm-submit"));

    await waitFor(() => expect(startSandboxAction).toHaveBeenCalledTimes(1));
    const [arg] = startSandboxAction.mock.calls[0] as [
      { templateId: string; name: string; setupPackages?: unknown },
    ];
    expect(arg.templateId).toBe("node");
    expect(arg.name).toBe("node box");
    expect(arg.setupPackages).toEqual([{ manager: "npm", names: ["express"] }]);
    await waitFor(() => expect(onWarmed).toHaveBeenCalledWith("sbx_new"));
  });

  it("folds an un-committed package draft in on warm", async () => {
    render(<SandboxCreateDialog {...baseProps()} />);
    fireEvent.click(screen.getByTestId("sandbox-runtime-python"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "py box" },
    });
    // Type a package but do NOT press Enter — warm should still include it.
    fireEvent.change(screen.getByTestId("sandbox-create-pkg-input"), {
      target: { value: "requests" },
    });
    fireEvent.click(screen.getByTestId("sandbox-warm-submit"));

    await waitFor(() => expect(startSandboxAction).toHaveBeenCalled());
    const [arg] = startSandboxAction.mock.calls[0] as [
      { setupPackages?: unknown },
    ];
    expect(arg.setupPackages).toEqual([
      { manager: "pip", names: ["requests"] },
    ]);
  });

  it("requires a name before warming", async () => {
    render(<SandboxCreateDialog {...baseProps()} />);
    // No name typed → warm button disabled, action never called.
    const warm = screen.getByTestId("sandbox-warm-submit") as HTMLButtonElement;
    expect(warm.disabled).toBe(true);
    fireEvent.click(warm);
    expect(startSandboxAction).not.toHaveBeenCalled();
  });

  it("hides the package field for the blank runtime", () => {
    render(<SandboxCreateDialog {...baseProps()} />);
    fireEvent.click(screen.getByTestId("sandbox-runtime-blank"));
    expect(screen.queryByTestId("sandbox-create-pkg-input")).toBeNull();
  });
});
