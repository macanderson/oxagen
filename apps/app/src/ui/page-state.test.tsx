// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denied, notBacked, readError } from "@/data/not-backed";
import { ErrorState } from "./error-state";
import { PageState } from "./page-state";
import { renderWithIntl } from "./testing/render-with-intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
});

describe("PageState", () => {
  it("names the milestone and gap for a read that is not backed", () => {
    renderWithIntl(<PageState page="fleet" result={notBacked("M2", "G3")} />);
    const state = screen.getByTestId("page-state-not_backed");
    expect(state).toHaveAccessibleName("Not recorded yet");
    expect(state).toHaveTextContent("milestone M2 (backend gap G3)");
    expect(state).not.toHaveTextContent("0");
  });

  it("says a spec decision, not a milestone, when that is what the read waits on", () => {
    renderWithIntl(
      <PageState page="tools" result={notBacked("spec-decision", "G12")} />,
    );
    const state = screen.getByTestId("page-state-not_backed");
    expect(state).toHaveTextContent(
      "waits on a spec decision (backend gap G12)",
    );
    expect(state).not.toHaveTextContent("milestone");
  });

  it("names the missing permission when denied", () => {
    renderWithIntl(
      <PageState page="audit" result={denied("audit.events.read")} />,
    );
    const state = screen.getByTestId("page-state-denied");
    expect(state).toHaveAccessibleName("You do not have access");
    expect(state).toHaveTextContent("Neededaudit.events.read");
  });

  it("falls back to the page's own permission when the read names none", () => {
    renderWithIntl(<PageState page="billing" result={denied("")} />);
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "Neededorg.billing",
    );
  });

  it("shows the error code and status the read carried", () => {
    renderWithIntl(
      <PageState
        page="tools"
        result={readError("tool_registry_unavailable", 503)}
      />,
    );
    const state = screen.getByTestId("page-state-error");
    expect(state).toHaveAccessibleName("This could not load");
    expect(state).toHaveTextContent("answered 503 tool_registry_unavailable");
  });

  it("falls back to the page's §2.1 code and status when the read has none", () => {
    renderWithIntl(<PageState page="ontology" result={readError("", 0)} />);
    expect(screen.getByTestId("page-state-error")).toHaveTextContent(
      "answered 504 graph_read_timeout",
    );
  });

  it("refreshes the route from the error state's retry", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <PageState
        page="run"
        result={readError("frame_store_unreachable", 502)}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders the generic empty state", () => {
    renderWithIntl(<PageState page="fleet" empty />);
    const state = screen.getByTestId("page-state-empty");
    expect(state).toHaveAccessibleName("Nothing here yet");
  });

  it("renders a page's own empty copy and actions", () => {
    renderWithIntl(
      <PageState
        page="fleet"
        empty
        title="No runs yet"
        body="Wrap an agent to see its first run here."
        actions={<button type="button">Register an agent</button>}
      />,
    );
    const state = screen.getByTestId("page-state-empty");
    expect(state).toHaveAccessibleName("No runs yet");
    expect(state).toHaveTextContent("Wrap an agent to see its first run here.");
    expect(
      screen.getByRole("button", { name: "Register an agent" }),
    ).toBeVisible();
  });

  it("renders the loading skeleton as one busy status", () => {
    renderWithIntl(<PageState page="spend" loading />);
    const state = screen.getByTestId("page-state-loading");
    expect(state).toHaveAttribute("role", "status");
    expect(state).toHaveAttribute("aria-busy", "true");
    expect(state).toHaveAccessibleName("Loading");
    expect(state).toHaveAttribute("data-layout", "table");
  });

  it.each(["detail", "tiles"] as const)(
    "renders the %s skeleton layout",
    (layout) => {
      renderWithIntl(<PageState page="run" loading layout={layout} />);
      expect(screen.getByTestId("page-state-loading")).toHaveAttribute(
        "data-layout",
        layout,
      );
    },
  );
});

describe("ErrorState", () => {
  it("calls an error boundary's retry instead of refreshing, and quotes the detail", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithIntl(
      <ErrorState
        code="frame_store_unreachable"
        status={502}
        detail="digest 01K5RSXQ7F2E"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByTestId("page-state-error")).toHaveTextContent(
      "digest 01K5RSXQ7F2E",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
