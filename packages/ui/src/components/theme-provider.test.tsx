// @vitest-environment jsdom
/**
 * theme-provider.test.tsx — render and behavior tests for ThemeProvider / useTheme.
 *
 * Covers:
 *  - ThemeProvider renders children and exposes context via useTheme
 *  - setTheme updates the resolved theme and writes the cookie
 *  - initialTheme prop wires through correctly
 *  - "system" theme resolves against the OS preference (window.matchMedia)
 *  - useTheme degrades to an inert default (no throw) outside a provider
 *  - BroadcastChannel cross-tab sync
 *  - cookie adoption on mount when no initialTheme
 *  - enableColorScheme / disableTransitionOnChange options
 */

import { render, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme-provider";
import { THEME_COOKIE_NAME } from "./theme-config";

afterEach(() => {
  cleanup();
  // Reset html class and cookies between tests.
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  document.cookie = `${THEME_COOKIE_NAME}=; Max-Age=0; Path=/`;
  vi.restoreAllMocks();
  // Restore any global stubs (vi.stubGlobal) set during the test.
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Consume the ThemeContext and surface values via data attributes. */
function ThemeInspector() {
  const { theme, resolvedTheme, themes, setTheme } = useTheme();
  return (
    <div
      data-theme={theme}
      data-resolved={resolvedTheme}
      data-themes={themes.join(",")}
    >
      <button type="button" onClick={() => setTheme("light")}>
        Set Light
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        Set Dark
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        Set System
      </button>
    </div>
  );
}

function makeMatchMedia(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ThemeProvider — children render", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("renders children without crashing", () => {
    const { getByText } = render(
      <ThemeProvider>
        <span>app content</span>
      </ThemeProvider>,
    );
    expect(getByText("app content")).toBeInTheDocument();
  });

  it("exposes theme, resolvedTheme, setTheme, themes via useTheme", () => {
    const { getByTestId } = render(
      <ThemeProvider initialTheme="light">
        <div data-testid="wrapper">
          <ThemeInspector />
        </div>
      </ThemeProvider>,
    );
    const wrapper = getByTestId("wrapper");
    const inspector = wrapper.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("light");
    expect(inspector.dataset["resolved"]).toBe("light");
    expect(inspector.dataset["themes"]).toContain("light");
    expect(inspector.dataset["themes"]).toContain("dark");
    expect(inspector.dataset["themes"]).toContain("system");
  });
});

describe("ThemeProvider — initialTheme", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("initialTheme=light → resolvedTheme=light and adds class to html", () => {
    render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("initialTheme=dark → resolvedTheme=dark and adds class to html", () => {
    render(
      <ThemeProvider initialTheme="dark">
        <ThemeInspector />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("defaults to system theme when no initialTheme provided", () => {
    const { container } = render(
      <ThemeProvider>
        <ThemeInspector />
      </ThemeProvider>,
    );
    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("system");
  });
});

describe("ThemeProvider — setTheme", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("setTheme('dark') updates the resolved theme class on html", async () => {
    const { getByRole } = render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );
    await userEvent.click(getByRole("button", { name: "Set Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("setTheme writes the theme cookie", async () => {
    const { getByRole } = render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );
    await userEvent.click(getByRole("button", { name: "Set Dark" }));
    expect(document.cookie).toContain(`${THEME_COOKIE_NAME}=dark`);
  });

  it("setTheme('light') switches from dark to light", async () => {
    const { getByRole } = render(
      <ThemeProvider initialTheme="dark">
        <ThemeInspector />
      </ThemeProvider>,
    );
    await userEvent.click(getByRole("button", { name: "Set Light" }));
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("ThemeProvider — system theme resolution", () => {
  it("system theme resolves to dark when OS prefers dark", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(true),
    });
    const { container } = render(
      <ThemeProvider initialTheme="system">
        <ThemeInspector />
      </ThemeProvider>,
    );
    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("system");
    expect(inspector.dataset["resolved"]).toBe("dark");
  });

  it("system theme resolves to light when OS prefers light", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
    const { container } = render(
      <ThemeProvider initialTheme="system">
        <ThemeInspector />
      </ThemeProvider>,
    );
    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("system");
    expect(inspector.dataset["resolved"]).toBe("light");
  });
});

describe("ThemeProvider — enableColorScheme", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("sets color-scheme style on html by default", () => {
    render(
      <ThemeProvider initialTheme="dark">
        <span />
      </ThemeProvider>,
    );
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("does not set color-scheme style when enableColorScheme=false", () => {
    render(
      <ThemeProvider initialTheme="dark" enableColorScheme={false}>
        <span />
      </ThemeProvider>,
    );
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});

describe("ThemeProvider — cookie adoption on mount (no initialTheme)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("adopts stored cookie theme on mount when initialTheme is omitted", () => {
    // Pre-seed the cookie.
    document.cookie = `${THEME_COOKIE_NAME}=dark; Path=/`;
    const { container } = render(
      <ThemeProvider>
        <ThemeInspector />
      </ThemeProvider>,
    );
    // After the mount effect runs, the cookie should be adopted.
    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    // The effect runs asynchronously but synchronously in act; the value should update.
    act(() => {});
    expect(inspector.dataset["theme"]).toBe("dark");
  });
});

describe("ThemeProvider — BroadcastChannel cross-tab sync", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("setTheme broadcasts via BroadcastChannel when available", async () => {
    const postMessageSpy = vi.fn();
    const closeSpy = vi.fn();
    const addEventListenerSpy = vi.fn();
    const removeEventListenerSpy = vi.fn();

    vi.stubGlobal(
      "BroadcastChannel",
      vi.fn().mockImplementation(() => ({
        postMessage: postMessageSpy,
        close: closeSpy,
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
      })),
    );

    const { getByRole } = render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );

    await userEvent.click(getByRole("button", { name: "Set Dark" }));
    expect(postMessageSpy).toHaveBeenCalledWith("dark");
    expect(closeSpy).toHaveBeenCalled();
  });

  it("receives incoming BroadcastChannel message and updates theme", () => {
    let capturedListener: ((e: MessageEvent) => void) | null = null;
    const addEventListenerSpy = vi.fn().mockImplementation((event, fn) => {
      if (event === "message")
        capturedListener = fn as (e: MessageEvent) => void;
    });

    vi.stubGlobal(
      "BroadcastChannel",
      vi.fn().mockImplementation(() => ({
        postMessage: vi.fn(),
        close: vi.fn(),
        addEventListener: addEventListenerSpy,
        removeEventListener: vi.fn(),
      })),
    );

    const { container } = render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );

    // Simulate receiving a "dark" message from another tab.
    act(() => {
      capturedListener?.({ data: "dark" } as MessageEvent);
    });

    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("dark");
  });
});

describe("ThemeProvider — disableTransitionOnChange=false", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("does not inject a transition-suppression style when disabled", () => {
    const before = document.head.querySelectorAll("style").length;
    render(
      <ThemeProvider initialTheme="light" disableTransitionOnChange={false}>
        <span />
      </ThemeProvider>,
    );
    // No extra style element injected (the suppress-transitions logic is skipped).
    expect(document.head.querySelectorAll("style").length).toBe(before);
  });
});

describe("ThemeProvider — BroadcastChannel unavailable", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("mounts without error when BroadcastChannel is undefined", () => {
    // Temporarily remove BroadcastChannel to simulate unsupported environments.
    const original = (globalThis as Record<string, unknown>)[
      "BroadcastChannel"
    ];
    (globalThis as Record<string, unknown>)["BroadcastChannel"] = undefined;
    const { getByText } = render(
      <ThemeProvider initialTheme="light">
        <span>no-broadcast</span>
      </ThemeProvider>,
    );
    expect(getByText("no-broadcast")).toBeInTheDocument();
    (globalThis as Record<string, unknown>)["BroadcastChannel"] = original;
  });
});

describe("ThemeProvider — BroadcastChannel non-string message", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("handles a non-string BroadcastChannel message (falls back to 'system')", () => {
    let capturedListener: ((e: MessageEvent) => void) | null = null;

    vi.stubGlobal(
      "BroadcastChannel",
      vi.fn().mockImplementation(() => ({
        postMessage: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn().mockImplementation((event, fn) => {
          if (event === "message")
            capturedListener = fn as (e: MessageEvent) => void;
        }),
        removeEventListener: vi.fn(),
      })),
    );

    const { container } = render(
      <ThemeProvider initialTheme="light">
        <ThemeInspector />
      </ThemeProvider>,
    );

    // Send a non-string payload — parseTheme(undefined) → "system".
    act(() => {
      capturedListener?.({ data: 42 } as unknown as MessageEvent);
    });

    const inspector = container.querySelector("[data-theme]") as HTMLElement;
    expect(inspector.dataset["theme"]).toBe("system");
  });
});

describe("useTheme — outside provider", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: makeMatchMedia(false),
    });
  });

  it("returns an inert default theme instead of throwing", () => {
    const seen: { theme?: string; resolvedTheme?: string; themesLen?: number } =
      {};
    function BareConsumer() {
      const { theme, resolvedTheme, themes } = useTheme();
      seen.theme = theme;
      seen.resolvedTheme = resolvedTheme;
      seen.themesLen = themes.length;
      return null;
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => render(<BareConsumer />)).not.toThrow();
    expect(seen.theme).toBe("system");
    expect(seen.resolvedTheme).toBe("light");
    expect(seen.themesLen).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it("warns (in non-production) when no provider is present", () => {
    function BareConsumer() {
      useTheme();
      return null;
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BareConsumer />);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no <ThemeProvider> ancestor found"),
    );
    warnSpy.mockRestore();
  });

  it("exposes a setTheme that is a safe no-op outside a provider", () => {
    let setter: ((t: "light" | "dark" | "system") => void) | null = null;
    function BareConsumer() {
      setter = useTheme().setTheme;
      return null;
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BareConsumer />);
    expect(setter).not.toBeNull();
    expect(() => setter?.("dark")).not.toThrow();
    warnSpy.mockRestore();
  });
});
