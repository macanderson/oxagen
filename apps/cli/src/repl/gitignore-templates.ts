/**
 * Curated .gitignore section templates for the deterministic turn resolver.
 *
 * Content is a conservative subset of the community github/gitignore templates:
 * every pattern here is a high-confidence artifact/tooling path that is safe to
 * ignore in ANY project of that kind. Patterns that commonly cause accidental
 * ignores of real source (e.g. Python's `lib/`, Java's `*.jar` which would hide
 * the Gradle wrapper, Go's contested `vendor/`) are deliberately excluded —
 * the deterministic path must never produce a .gitignore a user has to debug.
 * Keys are the canonical target ids the resolver's alias table maps onto.
 */
export interface GitignoreSection {
  /** Human display label used in transcript summaries ("macOS", "Python"). */
  label: string;
  /** The section body, one pattern per line, no leading/trailing blank lines. */
  body: string;
}

export const GITIGNORE_SECTIONS: Record<string, GitignoreSection> = {
  macos: {
    label: "macOS",
    body: [
      ".DS_Store",
      ".AppleDouble",
      ".LSOverride",
      "Icon?",
      "._*",
      ".DocumentRevisions-V100",
      ".fseventsd",
      ".Spotlight-V100",
      ".TemporaryItems",
      ".Trashes",
      ".VolumeIcon.icns",
    ].join("\n"),
  },
  windows: {
    label: "Windows",
    body: [
      "Thumbs.db",
      "Thumbs.db:encryptable",
      "ehthumbs.db",
      "ehthumbs_vista.db",
      "Desktop.ini",
      "$RECYCLE.BIN/",
      "*.lnk",
    ].join("\n"),
  },
  linux: {
    label: "Linux",
    body: ["*~", ".fuse_hidden*", ".directory", ".Trash-*", ".nfs*"].join("\n"),
  },
  python: {
    label: "Python",
    body: [
      "__pycache__/",
      "*.py[cod]",
      "*$py.class",
      "*.so",
      ".venv/",
      "venv/",
      "env/",
      "*.egg-info/",
      ".eggs/",
      "dist/",
      "build/",
      "wheels/",
      ".pytest_cache/",
      ".mypy_cache/",
      ".ruff_cache/",
      ".coverage",
      ".coverage.*",
      "htmlcov/",
      ".tox/",
      ".ipynb_checkpoints/",
    ].join("\n"),
  },
  node: {
    label: "Node.js",
    body: [
      "node_modules/",
      "npm-debug.log*",
      "yarn-debug.log*",
      "yarn-error.log*",
      "pnpm-debug.log*",
      "lerna-debug.log*",
      "dist/",
      "build/",
      ".next/",
      "out/",
      "coverage/",
      "*.tsbuildinfo",
      ".npm",
      ".eslintcache",
      ".turbo/",
      ".env.local",
      ".env.*.local",
    ].join("\n"),
  },
  go: {
    label: "Go",
    body: [
      "*.exe",
      "*.exe~",
      "*.dll",
      "*.so",
      "*.dylib",
      "*.test",
      "*.out",
      "go.work",
      "go.work.sum",
    ].join("\n"),
  },
  rust: {
    label: "Rust",
    body: ["target/", "**/*.rs.bk", "*.pdb"].join("\n"),
  },
  java: {
    label: "Java",
    body: [
      "*.class",
      "*.war",
      "*.ear",
      "target/",
      ".gradle/",
      "build/",
      "out/",
      ".settings/",
      ".project",
      ".classpath",
    ].join("\n"),
  },
  jetbrains: {
    label: "JetBrains IDEs",
    body: [".idea/", "*.iml", ".idea_modules/"].join("\n"),
  },
  vscode: {
    label: "VS Code",
    body: [
      ".vscode/*",
      "!.vscode/settings.json",
      "!.vscode/tasks.json",
      "!.vscode/launch.json",
      "!.vscode/extensions.json",
    ].join("\n"),
  },
};

/** Compose the final .gitignore from an ordered, deduped list of section keys. */
export function composeGitignore(keys: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const section = GITIGNORE_SECTIONS[key];
    if (!section) continue;
    parts.push(`# ${section.label}\n${section.body}`);
  }
  return parts.join("\n\n") + "\n";
}
