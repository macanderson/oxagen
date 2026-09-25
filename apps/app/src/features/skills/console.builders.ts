import type { SkillConfiguration } from "@/data/contracts/skills";
export const configuration: SkillConfiguration = {
  config: { enabled: false, search: { budget: 6000, cutoff: 0, limit: 10 } },
  draftText: "enabled = false\n",
  current: {
    id: "skv_123",
    version: "skl_v1",
    commitSha: "a".repeat(40),
    pullRequestNumber: 12,
    digest: `sha256:${"b".repeat(64)}`,
    publishedAt: "2026-09-20T10:00:00.000Z",
    searchable: true,
  },
  versions: [
    {
      id: "skv_123",
      version: "skl_v1",
      commitSha: "a".repeat(40),
      pullRequestNumber: 12,
      digest: `sha256:${"b".repeat(64)}`,
      publishedAt: "2026-09-20T10:00:00.000Z",
      searchable: true,
    },
  ],
};
