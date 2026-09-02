import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchAndRenderReadme } from "./readme";

afterEach(() => vi.unstubAllGlobals());

function stubReadme(md: string, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, text: async () => md })),
  );
}

describe("fetchAndRenderReadme", () => {
  it("renders markdown to sanitized HTML", async () => {
    stubReadme("# Hello\n\nSome **bold** text.");
    const html = await fetchAndRenderReadme({
      url: "https://github.com/x/repo",
      source: "github",
    });
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips script tags", async () => {
    stubReadme("ok\n\n<script>alert(1)</script>");
    const html = await fetchAndRenderReadme({
      url: "https://github.com/x/repo",
      source: "github",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("rewrites relative image src to the repo raw base", async () => {
    stubReadme("![logo](docs/logo.png)");
    const html = await fetchAndRenderReadme({
      url: "https://github.com/x/repo",
      source: "github",
    });
    expect(html).toContain(
      "https://raw.githubusercontent.com/x/repo/HEAD/docs/logo.png",
    );
  });

  it("returns null for a non-github repository", async () => {
    const html = await fetchAndRenderReadme({
      url: "https://gitlab.com/x/repo",
      source: "gitlab",
    });
    expect(html).toBeNull();
  });

  it("returns null when the README fetch fails", async () => {
    stubReadme("nope", false);
    const html = await fetchAndRenderReadme({
      url: "https://github.com/x/repo",
      source: "github",
    });
    expect(html).toBeNull();
  });
});
