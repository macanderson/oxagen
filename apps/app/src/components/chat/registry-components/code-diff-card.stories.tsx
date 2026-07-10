import type { Meta, StoryObj } from "@storybook/react-vite";
import CodeDiffCard from "./code-diff-card";

const meta = {
  title: "Chat/CodeDiffCard",
  component: CodeDiffCard,
} satisfies Meta<typeof CodeDiffCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLE_PATCH = [
  "@@ -12,6 +12,7 @@ export function greet(name: string) {",
  "   if (!name) {",
  "     throw new Error('name is required');",
  "   }",
  "-  return `Hi ${name}`;",
  "+  return `Hello, ${name}!`;",
  "+  // TODO: localize this greeting",
  " }",
].join("\n");

export const SingleFileWithPatch: Story = {
  args: {
    files: [{ path: "src/lib/greet.ts", patch: SAMPLE_PATCH }],
    summary: "Improved the greeting message and left a localization TODO.",
  },
};

export const MultipleFiles: Story = {
  args: {
    files: [
      { path: "src/lib/greet.ts", patch: SAMPLE_PATCH },
      {
        path: "src/lib/greet.test.ts",
        patch: [
          "@@ -1,3 +1,3 @@",
          " describe('greet', () => {",
          "-  it('returns Hi <name>', () => {});",
          "+  it('returns Hello, <name>!', () => {});",
          " });",
        ].join("\n"),
      },
    ],
    summary: "Renamed the greeting copy and updated the matching test expectation.",
  },
};

export const NoPatchAvailable: Story = {
  args: {
    // agent.repo.edit's contract output carries changed file PATHS only, not
    // patch bodies — this is the real-world shape resolveRenderDirective
    // produces for that capability today.
    files: [
      { path: "src/index.ts" },
      { path: "src/routes/health.ts" },
    ],
    summary: "Wired up the health-check route.",
    externalUrl: "https://github.com/acme/repo/pull/42",
    externalLabel: "PR #42",
  },
};

export const CommitLink: Story = {
  args: {
    files: [{ path: "README.md" }],
    externalUrl: "https://github.com/acme/repo/commit/a1b2c3d",
    externalLabel: "commit a1b2c3d",
  },
};

export const NewFile: Story = {
  args: {
    files: [
      {
        path: "src/lib/rate-limit.ts",
        patch: [
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/lib/rate-limit.ts",
          "@@ -0,0 +1,4 @@",
          "+export function rateLimit(key: string, limit: number) {",
          "+  // token-bucket stub",
          "+  return { key, limit, remaining: limit };",
          "+}",
        ].join("\n"),
      },
    ],
    summary: "Added a token-bucket rate limiter.",
  },
};

export const DeletedFile: Story = {
  args: {
    files: [
      {
        path: "src/legacy/old-helper.ts",
        patch: [
          "deleted file mode 100644",
          "--- a/src/legacy/old-helper.ts",
          "+++ /dev/null",
          "@@ -1,3 +0,0 @@",
          "-export function oldHelper() {",
          "-  return 'deprecated';",
          "-}",
        ].join("\n"),
      },
    ],
    summary: "Removed the deprecated helper.",
  },
};

export const LongDiffCollapsed: Story = {
  args: {
    // Over the collapse threshold: the tail hides behind a "Show N more lines"
    // expander so the card never dumps a huge patch fully open.
    files: [
      {
        path: "src/generated/routes.ts",
        patch: [
          "@@ -0,0 +1,40 @@",
          ...Array.from(
            { length: 40 },
            (_, i) => `+export const route${i} = "/api/v1/resource-${i}";`,
          ),
        ].join("\n"),
      },
    ],
    summary: "Regenerated the route manifest.",
  },
};

export const Empty: Story = {
  args: { files: [] },
};
