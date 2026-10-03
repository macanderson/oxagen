import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSurfaceMark,
  brandPath,
  desktopIconDrift,
  expectedInk,
  houseGroundsModule,
  rewriteInk,
  startupImages,
  staticPwaHead,
  withPwaHead,
} from "./sync-brand-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./sync-brand-assets.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Write `content` at `root/rel`, making the folders it needs. */
function put(root: string, rel: string, content: string | Buffer) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A copy of the repo with just what the script imports and edits in place:
 * the script, its entrypoint helper and literal guard, apps/web's palette
 * module, and the six hand-authored pages the sync writes a <head> block into.
 * The story and read pages link no site stylesheet, so each sets its own
 * heading face, as the type pass requires (oxageninc/brand#83).
 */
function fixtureRepo(root: string) {
  const copyIn = (rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(root, rel));
  };
  copyIn("tools/scripts/sync-brand-assets.mjs");
  copyIn("tools/scripts/lib/is-entrypoint.mjs");
  copyIn("tools/scripts/lib/brand-literals.mjs");
  copyIn("apps/web/scripts/lib/theme.mjs");
  for (const page of [
    "index.html",
    "story/index.html",
    "read/index.html",
    "products/oxagen/index.html",
    "terms/index.html",
    "privacy/index.html",
  ]) {
    const faces = ["story/index.html", "read/index.html"].includes(page)
      ? "<style>h1, h2, h3 { font-family: var(--ox-font-display); }</style>\n"
      : "";
    put(
      root,
      `apps/web/${page}`,
      `<head>\n<link rel="manifest" href="/oxagen.webmanifest">\n${faces}</head>\n`,
    );
  }
  return join(root, "tools/scripts/sync-brand-assets.mjs");
}

const TOKENS = {
  ink: "#09090B",
  paper: "#FFFFFF",
  panel: "#18181B",
  hl: "#27272A",
  border: "#27272A",
  rule: "#3F3F46",
  dim: "#71717A",
  muted: "#A1A1AA",
  "text-body": "#E4E4E7",
  text: "#FFFFFF",
  gold: "#D4AF37",
};

/**
 * A kit with every file the sync reads. Each file's bytes name the file, so
 * no two are alike. The marks carry the shapes `marks()` parses.
 */
function fakeKit(kit: string) {
  put(
    kit,
    "tokens/house-tokens.json",
    JSON.stringify({ version: "9.9.9", gold: { hex: TOKENS.gold }, tokens: TOKENS }),
  );
  for (const f of ["house-tokens.css", "house-tailwind.css"]) put(kit, `tokens/${f}`, `/* ${f} */\n`);
  put(kit, "tokens/house-fonts.css", "@font-face { src: url(../fonts/face.woff2); }\n");
  put(kit, "fonts/face.woff2", "face");
  put(kit, "fonts/LICENSE-OFL.txt", "licence");
  for (const b of ["oxagen", "stella"]) {
    const wordmark =
      '<svg viewBox="0 0 120 30"><path class="letters" d="M0 0h1"/><path class="accent" d="M2 0h1"/></svg>';
    const icon =
      '<svg viewBox="0 0 96 96"><g transform="translate(1 1)"><path d="M0 0h1" stroke="currentColor" stroke-width="2"/><path d="M1 1h1" fill="#D4AF37" opacity="0.55"/></g></svg>';
    put(kit, `logo/svg/${b}-wordmark-adaptive.svg`, wordmark);
    put(kit, `logo/svg/${b}-icon-adaptive.svg`, icon);
    for (const v of ["wordmark-dark", "wordmark-light", "icon-tile-dark", "icon-tile-light"]) {
      put(kit, `logo/svg/${b}-${v}.svg`, `<svg id="${b}-${v}"/>`);
    }
    for (const v of ["avatar-light", "avatar-dark"]) put(kit, `social/${b}-${v}.svg`, `<svg id="${b}-${v}"/>`);
  }
  put(kit, "logo/svg/oxagen-favicon.svg", '<svg id="favicon"/>');
  for (const scheme of ["dark", "light"]) {
    put(kit, `social/oxagen-og-1200x630-${scheme}.png`, `og ${scheme}`);
    put(kit, `splash/oxagen-splash-1x2-${scheme}.png`, `splash ${scheme}`);
  }
  put(
    kit,
    "splash/splash-screens.json",
    JSON.stringify({
      screens: [{ file: "{brand}-splash-1x2-{scheme}.png", media: "(device-width: 1px)" }],
    }),
  );
  for (const f of ["oxagen-spinner.svg", "oxagen-spinner-wordmark.svg"]) put(kit, `spinners/${f}`, f);
  for (const size of [16, 32, 48, 180, 192, 512]) put(kit, `icons/oxagen-icon-${size}.png`, `icon ${size}`);
  for (const size of [192, 512]) {
    put(kit, `icons/oxagen-icon-maskable-${size}.png`, `maskable ${size}`);
    put(kit, `icons/oxagen-icon-maskable-light-${size}.png`, `maskable light ${size}`);
  }
  put(kit, "icons/oxagen-favicon.ico", "ico");
  put(
    kit,
    "icons/oxagen.webmanifest",
    JSON.stringify({ name: "Oxagen", theme_color: TOKENS.ink, icons: [] }),
  );
  put(kit, "pwa/install-prompt.js", "// prompt\n");
  put(kit, "skills/stub/oxagen-branding/SKILL.md", "---\nname: oxagen-branding\n---\nstub\n");
}

/** Every file under `root`, as relative paths with their sha256. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = sha256(readFileSync(join(root, child)));
    }
  };
  walk("");
  return out;
}

describe("brand kit selection", () => {
  it("finds the sibling checkout without an override", () => {
    expect(brandPath([], {}, "/projects/oxagen")).toBe("/projects/oxagen-brand");
  });

  it("prefers --brand, then OXAGEN_BRAND_KIT", () => {
    expect(brandPath([], { OXAGEN_BRAND_KIT: "/kit" })).toBe("/kit");
    expect(
      brandPath(["--brand", "/explicit-kit"], { OXAGEN_BRAND_KIT: "/kit" }),
    ).toBe("/explicit-kit");
  });

  it("no longer reads the retired OXAGEN_HOUSE_BRAND name", () => {
    expect(
      brandPath([], { OXAGEN_HOUSE_BRAND: "/old-kit" }, "/projects/oxagen"),
    ).toBe("/projects/oxagen-brand");
  });
});

describe("surface mark selection", () => {
  it.each([
    "apps/app/public",
    "apps/docs/public",
    "apps/app_deprecated/public",
  ])("admits selected wordmarks, icons, and avatars in %s", (surface) => {
    for (const brand of ["oxagen", "stella"]) {
      for (const variant of ["wordmark", "icon", "avatar-dark"]) {
        expect(() =>
          assertSurfaceMark(`${surface}/brand/${brand}-${variant}.svg`),
        ).not.toThrow();
      }
    }
    expect(() =>
      assertSurfaceMark(`${surface}/brand/oxagen-lockup.svg`),
    ).toThrow("not selected");
  });

  it("applies the web surface's own selection", () => {
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/oxagen-spinner.svg"),
    ).not.toThrow();
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/stella-wordmark.svg"),
    ).toThrow("not selected");
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/oxagen-lockup-dark.svg"),
    ).toThrow("not selected");
  });

  it("refuses marks on an undeclared surface and leaves other assets alone", () => {
    expect(() =>
      assertSurfaceMark("apps/new/public/brand/oxagen-wordmark.svg"),
    ).toThrow("not selected");
    expect(() =>
      assertSurfaceMark("apps/app/public/favicon/favicon.svg"),
    ).not.toThrow();
  });
});

describe("a run without a kit", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oxagen-brand-nokit-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, [script, ...args, "--brand", join(root, "missing-kit")], {
      encoding: "utf8",
    });

  // #4804: the check used to print SKIPPED and exit 0 off CI, so a gate with
  // no kit read green having verified nothing.
  it("fails a check and names the kit it could not find", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check", "--brand", "/no/such/kit"], {
      encoding: "utf8",
      env: { ...process.env, CI: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("brand: FAILED");
    expect(result.stderr).toContain("/no/such/kit");
    expect(result.stderr).toContain("nothing was checked");
    expect(result.stdout).not.toContain("SKIPPED");
  });

  it("fails a sync, so the fan-out cannot open an empty PR", () => {
    const script = fixtureRepo(root);
    const result = run(script, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("nothing was synced");
  });

  it("ignores Finder metadata but still refuses an unselected mark first", () => {
    const script = fixtureRepo(root);
    const surface = join(root, "apps/app/public/brand");
    mkdirSync(surface, { recursive: true });
    writeFileSync(join(surface, ".DS_Store"), "finder metadata");
    const valid = run(script, ["--check"]);
    expect(valid.status).toBe(2);
    expect(valid.stderr).toContain("No house kit");
    writeFileSync(join(surface, "oxagen-lockup.svg"), "<svg/>");
    const invalid = run(script, ["--check"]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("not selected");
  });
});

// The contract every consumer repo meets (oxageninc/brand
// CHANGING.md): a sync copies the kit byte for byte, a check right after it
// passes, and a check writes nothing and lists every file out of step.
describe("a sync and a check against a kit", () => {
  let root: string;
  let kit: string;
  let script: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oxagen-brand-sync-"));
    kit = join(root, "kit");
    const repo = join(root, "repo");
    script = fixtureRepo(repo);
    fakeKit(kit);
    // The vendored skill this repo used to carry.
    put(repo, ".claude/skills/oxagen-branding/SKILL.md", "full skill\n");
    put(repo, ".claude/skills/oxagen-branding/references/voice.md", "voice\n");
    put(repo, ".claude/skills/oxagen-branding/assets/tokens.css", "tokens\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const repo = () => join(root, "repo");
  const sync = (...args: string[]) =>
    spawnSync(process.execPath, [script, "--brand", kit, ...args], { encoding: "utf8" });
  /** Stamp the desktop icons as cut from the avatar the sync wrote. */
  const stampDesktop = () => {
    const avatar = "apps/app/public/brand/oxagen-avatar-light.svg";
    put(
      repo(),
      "apps/desktop/src-tauri/icons/source.sha256",
      `${sha256(readFileSync(join(repo(), avatar)))}  ${avatar}\n`,
    );
  };

  it("passes a check right after a sync", () => {
    expect(sync().status).toBe(0);
    stampDesktop();
    const check = sync("--check");
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toMatch(/^brand: \d+ files match brand kit 9\.9\.9/);
  });

  it("copies every raster byte for byte and renders none", () => {
    sync();
    const pairs: Array<[string, string]> = [
      ["icons/oxagen-icon-16.png", "apps/app/public/favicon/favicon-16.png"],
      ["icons/oxagen-favicon.ico", "apps/docs/public/favicon/favicon.ico"],
      ["icons/oxagen-icon-180.png", "apps/app/public/pwa/apple-touch-icon.png"],
      ["icons/oxagen-icon-maskable-light-512.png", "apps/app/public/pwa/maskable-light-512.png"],
      ["icons/oxagen-icon-maskable-192.png", "apps/web/maskable-192.png"],
      ["splash/oxagen-splash-1x2-dark.png", "apps/app/public/pwa/splash/oxagen-splash-1x2-dark.png"],
    ];
    for (const [from, to] of pairs) {
      expect(readFileSync(join(repo(), to))).toEqual(readFileSync(join(kit, from)));
    }
  });

  it("replaces the vendored skill with the kit's stub and nothing else", () => {
    const result = sync();
    expect(result.stdout).toContain("removed 2 file(s)");
    const dir = join(repo(), ".claude/skills/oxagen-branding");
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);
    expect(readFileSync(join(dir, "SKILL.md"))).toEqual(
      readFileSync(join(kit, "skills/stub/oxagen-branding/SKILL.md")),
    );
  });

  it("writes the kit's gold into the marks module as a colour", () => {
    expect(sync().status).toBe(0);
    const module = readFileSync(
      join(repo(), "packages/ui/src/components/brand-marks.generated.ts"),
      "utf8",
    );
    expect(module).toContain('export const BRAND_GOLD = "#D4AF37";');
  });

  it("refuses a kit gold that is not a #rrggbb colour, so kit data never becomes code", () => {
    put(
      kit,
      "tokens/house-tokens.json",
      JSON.stringify({
        version: "9.9.9",
        gold: { hex: '#D4AF37"; globalThis.pwned = true; //' },
        tokens: TOKENS,
      }),
    );
    const result = sync();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("house kit gold is not a #rrggbb colour");
    expect(
      existsSync(join(repo(), "packages/ui/src/components/brand-marks.generated.ts")),
    ).toBe(false);
  });

  it("writes the two grounds from the kit's tokens", () => {
    sync();
    const module = readFileSync(join(repo(), "packages/ui/src/lib/house-grounds.ts"), "utf8");
    expect(module).toContain('export const HOUSE_INK = "#09090B";');
    expect(module).toContain('export const HOUSE_PAPER = "#FFFFFF";');
  });

  it("writes nothing on a check, and lists each file out of step", () => {
    sync();
    stampDesktop();
    put(repo(), "apps/app/public/favicon/favicon-32.png", "edited by hand");
    rmSync(join(repo(), "apps/web/icon-512.png"));
    put(repo(), ".claude/skills/oxagen-branding/references/words.md", "stray\n");
    const before = snapshot(repo());
    const check = sync("--check");
    expect(snapshot(repo())).toEqual(before);
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/differs\s+apps\/app\/public\/favicon\/favicon-32\.png/);
    expect(check.stderr).toMatch(/missing\s+apps\/web\/icon-512\.png/);
    expect(check.stderr).toMatch(/extra\s+\.claude\/skills\/oxagen-branding\/references\/words\.md/);
    expect(check.stderr).toContain("Run node tools/scripts/sync-brand-assets.mjs --brand <kit>");
  });

  // oxageninc/brand#63: a guarded stylesheet takes its corners, shadows, type
  // sizes, and page wrap from the kit's tokens, so a theme change reaches it.
  it("fails a check on a literal in a guarded stylesheet, naming the line, until it reads a token", () => {
    sync();
    stampDesktop();
    const sheet = "packages/ui/src/styles/globals.css";
    put(repo(), sheet, ":root {\n  --ui-radius: 0.5rem;\n}\n");
    const literal = sync("--check");
    expect(literal.status).toBe(1);
    expect(literal.stderr).toMatch(
      /literal\s+packages\/ui\/src\/styles\/globals\.css \(line 2: --ui-radius: 0\.5rem; use /,
    );
    expect(literal.stderr).toContain("KEEP in tools/scripts/lib/brand-literals.mjs");
    put(repo(), sheet, ":root {\n  --ui-radius: var(--ox-radius-base);\n}\n");
    const fixed = sync("--check");
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  // oxageninc/brand#83: a customer page sets no size by hand, none under
  // 14px, and h1 to h3 in Space Grotesk.
  it("fails a check on a type break in a customer page, naming the line, until it reads a token", () => {
    sync();
    stampDesktop();
    const page = "apps/web/story/index.html";
    const head = readFileSync(join(repo(), page), "utf8");
    put(repo(), page, head.replace("</head>", "<style>\n.tag { font-size: 12px; }\n</style>\n</head>"));
    const broken = sync("--check");
    expect(broken.status).toBe(1);
    expect(broken.stderr).toMatch(
      /type\s+apps\/web\/story\/index\.html \(line \d+: font-size: 12px; use .*no text on a customer site is under 14px/,
    );
    expect(broken.stderr).toContain("KEEP excuses no size under 14px");
    put(repo(), page, head.replace("</head>", "<style>\n.tag { font-size: var(--ox-m-micro); }\n</style>\n</head>"));
    const fixed = sync("--check");
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  it("names an allowlisted literal its stylesheet no longer writes", () => {
    sync();
    stampDesktop();
    put(repo(), "apps/app/src/ui/phone.css", "input { font-size: var(--ox-a-body); }\n");
    const check = sync("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/keep\s+apps\/app\/src\/ui\/phone\.css \(the allowlist .* keeps font-size 16px/);
  });

  it("fails a check when the kit changes, until the sync runs", () => {
    sync();
    stampDesktop();
    put(kit, "icons/oxagen-icon-192.png", "a new hive");
    const stale = sync("--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/differs\s+apps\/app\/public\/pwa\/icon-192\.png/);
    sync();
    const fixed = sync("--check");
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  // #4892: a kit icon change must keep CI red until the desktop icons follow.
  it("fails a check when the avatar changes, until the desktop icons are cut again", () => {
    sync();
    stampDesktop();
    put(kit, "social/oxagen-avatar-light.svg", '<svg id="a new avatar"/>');
    const write = sync();
    expect(write.status).toBe(0);
    expect(write.stderr).toContain("the desktop icons are stale");
    const check = sync("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(
      /stale\s+apps\/desktop\/src-tauri\/icons\/source\.sha256 \(the icons were cut from an older apps\/app\/public\/brand\/oxagen-avatar-light\.svg\)/,
    );
    expect(check.stderr).toContain("pnpm --filter @oxagen/desktop icons");
    stampDesktop();
    const fixed = sync("--check");
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  // Codex review on #4906: a file the kit stopped shipping stayed in place,
  // and the check passed over it.
  it("removes an icon the kit no longer ships, and a check lists it first", () => {
    sync();
    stampDesktop();
    put(repo(), "apps/app/public/pwa/icon-128.png", "an old size");
    put(repo(), "apps/web/icon-96.png", "an old size");
    put(repo(), "apps/web/robots.txt", "not an icon");
    const check = sync("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/extra\s+apps\/app\/public\/pwa\/icon-128\.png/);
    expect(check.stderr).toMatch(/extra\s+apps\/web\/icon-96\.png/);
    expect(check.stderr).not.toContain("robots.txt");
    expect(sync().status).toBe(0);
    expect(existsSync(join(repo(), "apps/app/public/pwa/icon-128.png"))).toBe(false);
    expect(existsSync(join(repo(), "apps/web/icon-96.png"))).toBe(false);
    expect(existsSync(join(repo(), "apps/web/robots.txt"))).toBe(true);
    const fixed = sync("--check");
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  // Codex review on #4906: a stamp that held only the source accepted a
  // desktop icon edited after the cut.
  it("fails a check when a desktop icon changes after the cut", () => {
    sync();
    const avatar = "apps/app/public/brand/oxagen-avatar-light.svg";
    const icon = "apps/desktop/src-tauri/icons/icon.png";
    put(repo(), icon, "cut from the avatar");
    put(
      repo(),
      "apps/desktop/src-tauri/icons/source.sha256",
      `${sha256(readFileSync(join(repo(), avatar)))}  ${avatar}\n${sha256("cut from the avatar")}  ${icon}\n`,
    );
    const cut = sync("--check");
    expect(cut.status, cut.stderr).toBe(0);
    put(repo(), icon, "edited by hand");
    const edited = sync("--check");
    expect(edited.status).toBe(1);
    expect(edited.stderr).toContain(`${icon} changed after the cut`);
  });

  it("fails a check when the desktop icons carry no stamp", () => {
    sync();
    const check = sync("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("no stamp");
    expect(existsSync(join(repo(), "apps/desktop/src-tauri/icons/source.sha256"))).toBe(false);
  });
});

describe("the desktop icon stamp", () => {
  const avatar = "apps/app/public/brand/oxagen-avatar-light.svg";
  const icon = "apps/desktop/src-tauri/icons/icon.png";
  const bytes = Buffer.from("<svg/>");
  const png = Buffer.from("png");
  const synced = new Map([[avatar, bytes]]);
  const icons = new Map([[icon, png]]);
  const stamp = `${sha256(bytes)}  ${avatar}\n${sha256(png)}  ${icon}\n`;

  it("matches the avatar the sync writes and the icons the cut wrote, in shasum's own format", () => {
    expect(desktopIconDrift(stamp, synced, icons)).toBeNull();
    expect(
      desktopIconDrift(`${sha256(bytes)} *${avatar}\n${sha256(png)} *${icon}`, synced, icons),
    ).toBeNull();
  });

  it("names an older source, a missing stamp, and a path the sync does not write", () => {
    expect(desktopIconDrift(`${"0".repeat(64)}  ${avatar}`, synced, new Map())).toBe(
      `the icons were cut from an older ${avatar}`,
    );
    expect(desktopIconDrift(null, synced, icons)).toContain("no stamp");
    expect(desktopIconDrift(`${sha256(bytes)}  elsewhere.svg`, synced, icons)).toContain(
      "elsewhere.svg, which this sync does not write",
    );
    expect(desktopIconDrift("not a stamp", synced, icons)).toContain("not `<sha256>");
  });

  it("names an icon changed after the cut, a missing one, and one no cut wrote", () => {
    expect(desktopIconDrift(stamp, synced, new Map([[icon, Buffer.from("edited")]]))).toBe(
      `${icon} changed after the cut`,
    );
    expect(desktopIconDrift(stamp, synced, new Map())).toBe(`${icon} is in the stamp but missing`);
    const extra = "apps/desktop/src-tauri/icons/extra.png";
    expect(desktopIconDrift(stamp, synced, new Map([...icons, [extra, png]]))).toBe(
      `${extra} is not in the stamp, so no cut wrote it`,
    );
  });
});

describe("the two grounds", () => {
  it("are the kit's ink and paper tokens", () => {
    const module = houseGroundsModule(TOKENS);
    expect(module).toContain('export const HOUSE_INK = "#09090B";');
    expect(module).toContain('export const HOUSE_PAPER = "#FFFFFF";');
  });

  it("fail loudly on a token the kit does not define", () => {
    expect(() => houseGroundsModule({ ink: "#09090B" })).toThrow(
      'house kit has no colour token "paper"',
    );
  });

  it("are what the committed module says", () => {
    const tokens = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/ui/src/styles/house-tokens.json"), "utf8"),
    ).tokens;
    expect(
      readFileSync(join(REPO_ROOT, "packages/ui/src/lib/house-grounds.ts"), "utf8"),
    ).toBe(houseGroundsModule(tokens));
  });
});

// #3074: the check verified nothing about apps/web's art modules, and
// theme.mjs had drifted (INK.dim #52525B against the kit's #71717A).
describe("the web art palette", () => {
  const theme = [
    "// header",
    "export const INK = Object.freeze({",
    '  ground: "#09090B",',
    '  dim: "#52525B",',
    '  silver: "#A1A1AA",',
    "});",
    "",
    "export function lineTones(t = INK) {",
    "  return [t.dim];",
    "}",
    "",
  ].join("\n");
  const map = { ground: "ink", dim: "dim", silver: "muted" };

  it("maps each INK key to the hex of the kit token it names", () => {
    expect(expectedInk(TOKENS, map)).toEqual({
      ground: "#09090B",
      dim: "#71717A",
      silver: "#A1A1AA",
    });
  });

  it("covers every INK key with a real kit token by default", () => {
    const ink = expectedInk(TOKENS);
    expect(Object.keys(ink).sort()).toEqual(
      [
        "body",
        "dim",
        "gold",
        "ground",
        "line",
        "muted",
        "panel",
        "raised",
        "rule",
        "silver",
        "text",
      ].sort(),
    );
  });

  it("fails loudly on a token the kit does not define", () => {
    expect(() => expectedInk({}, { dim: "dim" })).toThrow(
      'house kit has no colour token "dim" for INK.dim',
    );
  });

  it("rewrites a drifted value and leaves everything else byte for byte", () => {
    const out = rewriteInk(theme, expectedInk(TOKENS, map));
    expect(out).not.toBe(theme);
    expect(out).toBe(theme.replace('dim: "#52525B"', 'dim: "#71717A"'));
  });

  it("returns the source unchanged when it already matches, so --check passes", () => {
    const current = theme.replace('dim: "#52525B"', 'dim: "#71717A"');
    expect(rewriteInk(current, expectedInk(TOKENS, map))).toBe(current);
  });

  it("refuses a palette it cannot read rather than passing over it", () => {
    expect(() => rewriteInk("export const X = 1;\n", { dim: "#71717A" })).toThrow(
      "no `export const INK` block",
    );
    expect(() => rewriteInk(theme, { gold: "#D4AF37" })).toThrow(
      "INK has no gold colour",
    );
  });
});

/** The text of the step named `name` in `steps`, up to the next step. */
function stepIn(steps: string, name: string) {
  const at = steps.indexOf(`- name: ${name}\n`);
  if (at < 0) return "";
  const next = steps.indexOf("\n      - ", at + 1);
  return steps.slice(at, next < 0 ? undefined : next);
}

const CHECK_COMMAND = "node tools/scripts/sync-brand-assets.mjs --brand .brand-kit --check";

// The kit's conformance check looks for this file, and the kit's CHANGING.md
// sets its shape: every PR, every push to main, daily, and by hand, against
// the kit's main branch with no pin.
describe("brand-drift.yml", () => {
  const workflow = readFileSync(
    join(REPO_ROOT, ".github/workflows/brand-drift.yml"),
    "utf8",
  );

  it("is the brand-drift workflow with one Brand drift job", () => {
    expect(workflow).toMatch(/^name: brand-drift$/m);
    expect(workflow).toMatch(/^jobs:\n {2}brand-drift:\n {4}name: Brand drift\n/m);
  });

  it("runs on every pull request, on main, daily, and by hand", () => {
    expect(workflow).toMatch(/^ {2}pull_request:$/m);
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: "[^"]+"$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it("checks out the kit at main into .brand-kit, with no pin", () => {
    const checkout = stepIn(workflow, "Check out the brand kit");
    expect(checkout).toContain("repository: oxageninc/brand");
    expect(checkout).toMatch(/\n\s+ref: main\n/);
    expect(checkout).toContain("path: .brand-kit");
    expect(checkout).not.toContain("token:");
  });

  it("sets up Node 24 and runs the check with nothing installed", () => {
    expect(workflow).toMatch(/node-version: 24\n/);
    expect(workflow).not.toMatch(/run: pnpm|pnpm\/action-setup/);
    const check = stepIn(workflow, "Brand files match the kit");
    expect(check).toContain(CHECK_COMMAND);
    expect(check).toMatch(/::error::.*Run node tools\/scripts\/sync-brand-assets\.mjs/);
  });

  // #5131: the main ruleset requires Brand drift. A required check that never
  // runs blocks the merge for good, so the workflow takes no paths filter and
  // the job no condition. The pull request rule keeps a kit merge from failing
  // every other pull request, which took the blocking check offline in #4938.
  it("runs on every pull request and fails only one that touches what it guards", () => {
    expect(workflow).toMatch(/^ {2}pull_request:\n {2}[a-z]/m);
    expect(workflow).not.toMatch(/^\s+paths(-ignore)?:/m);
    expect(workflow).not.toMatch(/^ {4}if:/m);
    expect(workflow).toMatch(/fetch-depth: 2\n/);
    const check = stepIn(workflow, "Brand files match the kit");
    expect(check).toContain('if [ "$EVENT" = pull_request ]; then');
    expect(check).toContain("git diff --name-only HEAD^1 HEAD");
    expect(check).toContain(
      "tools/scripts/sync-brand-assets.mjs|tools/scripts/lib/brand-literals.mjs|.github/workflows/brand-drift.yml",
    );
  });
});

// #3074: check:brand ran only in the local gate, so CI checked no vendored
// brand file. The checks job, which the main ruleset requires, runs the same
// command as brand-drift.yml, so the two cannot disagree (#4804).
describe("the checks job runs the brand check", () => {
  const pipeline = readFileSync(
    join(REPO_ROOT, ".github/workflows/pipeline.yml"),
    "utf8",
  );
  const start = pipeline.indexOf("\n  checks:\n");
  const end = pipeline.indexOf("\n  build:\n", start);
  const checks = pipeline.slice(start, end);

  it("finds the checks job", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("checks out the kit at main into .brand-kit", () => {
    const checkout = stepIn(checks, "Check out the brand kit");
    expect(checkout).toContain("uses: actions/checkout@");
    expect(checkout).toContain("repository: oxageninc/brand");
    expect(checkout).toContain("path: .brand-kit");
    expect(checkout).toMatch(/\n\s+ref: main\n/);
  });

  it("runs the same command as brand-drift.yml, after the checkout", () => {
    const check = stepIn(checks, "Brand assets match the house kit");
    expect(check).toContain(CHECK_COMMAND);
    expect(check).not.toContain("pnpm check:brand");
    const checkoutAt = checks.indexOf("- name: Check out the brand kit");
    const checkAt = checks.indexOf("- name: Brand assets match the house kit");
    expect(checkAt).toBeGreaterThan(checkoutAt);
  });

  it("runs both steps after an earlier check fails", () => {
    const guard = "if: ${{ !cancelled() && steps.install.outcome == 'success' }}";
    expect(stepIn(checks, "Check out the brand kit")).toContain(guard);
    expect(stepIn(checks, "Brand assets match the house kit")).toContain(guard);
  });

  it("keeps the local root script on the same check", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(scripts["check:brand"]).toBe(
      "node tools/scripts/sync-brand-assets.mjs --check",
    );
  });
});

describe("launch screens and the install prompt", () => {
  const screens = [
    {
      file: "{brand}-splash-1179x2556-{scheme}.png",
      media:
        "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)",
    },
  ];

  it("lists one launch screen per screen and scheme, keyed to the scheme", () => {
    const images = startupImages(screens, "oxagen", "/pwa/splash/");
    expect(images).toEqual([
      {
        url: "/pwa/splash/oxagen-splash-1179x2556-dark.png",
        media: `${screens[0]?.media} and (prefers-color-scheme: dark)`,
      },
      {
        url: "/pwa/splash/oxagen-splash-1179x2556-light.png",
        media: `${screens[0]?.media} and (prefers-color-scheme: light)`,
      },
    ]);
  });

  const block = staticPwaHead(startupImages(screens, "oxagen", "/splash/"), {
    title: "Oxagen",
    script: "/assets/install-prompt.js",
    icon: "/icon-192.png",
  });

  it("writes the home-screen metas, the launch screens, and the prompt", () => {
    expect(block).toContain(
      '<meta name="apple-mobile-web-app-capable" content="yes">',
    );
    expect(block.match(/rel="apple-touch-startup-image"/g)).toHaveLength(2);
    expect(block).toContain(
      '<script src="/assets/install-prompt.js" defer data-icon="/icon-192.png"></script>',
    );
  });

  const page =
    '<head>\n<link rel="manifest" href="/oxagen.webmanifest">\n<title>x</title>\n</head>';

  it("places the block after the manifest link on a page that has none", () => {
    const out = withPwaHead(page, block);
    expect(out).toContain(
      `<link rel="manifest" href="/oxagen.webmanifest">\n${block}\n<title>`,
    );
  });

  it("replaces the block in place, so a re-sync changes nothing", () => {
    const once = withPwaHead(page, block);
    expect(withPwaHead(once, block)).toBe(once);
    const moved = withPwaHead(once, block.replace("Oxagen", "Renamed"));
    expect(moved).toContain('content="Renamed"');
    expect(moved.match(/<!-- \/pwa -->/g)).toHaveLength(1);
  });

  it("refuses a page with no manifest link, or a block with no end (negative)", () => {
    expect(() => withPwaHead("<head></head>", block)).toThrow(
      "no manifest link",
    );
    expect(() =>
      withPwaHead(
        "<!-- pwa: written by tools/scripts/sync-brand-assets.mjs -->",
        block,
      ),
    ).toThrow("no end marker");
  });
});
