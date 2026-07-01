import type { SourceRef } from "./types";

/**
 * The only external sources this dashboard is allowed to cite. Every entry
 * needs a real https URL and, where the fact is time-sensitive (a paper, a
 * blog post), a publication date — leaderboards change constantly, so we link
 * to them live instead of reprinting a snapshot that would go stale. Do not
 * add an entry here without a real, checkable URL.
 */
export const SOURCES: readonly SourceRef[] = [
  {
    title: "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?",
    url: "https://arxiv.org/abs/2310.06770",
    kind: "paper",
    published: "2023-10-10",
    description:
      "Jimenez et al., ICLR 2024. Introduces SWE-bench: agents are given a real GitHub issue and the repo at the failing commit, and are scored by whether their patch makes the repo's own hidden tests pass.",
  },
  {
    title: "Introducing SWE-bench Verified",
    url: "https://openai.com/index/introducing-swe-bench-verified/",
    kind: "paper",
    published: "2024-08-13",
    description:
      "OpenAI's human-validated 500-task subset of SWE-bench's test split, screened by professional software developers to remove underspecified or unsolvable issues.",
  },
  {
    title: "SWE-bench official leaderboards",
    url: "https://www.swebench.com",
    kind: "leaderboard",
    description:
      "Third-party-hosted, continuously updated Lite / Verified / Full / Multimodal / Multilingual boards. A checkmark denotes a verified submission; Open/Scaffold filters distinguish open-source and scaffold entries. We link here instead of reprinting a snapshot.",
  },
  {
    title: "SWE-bench (GitHub repository)",
    url: "https://github.com/SWE-bench/SWE-bench",
    kind: "tool",
    description: "The reference dataset, task collection pipeline, and evaluation harness.",
  },
  {
    title: "Terminal-Bench",
    url: "https://www.tbench.ai/",
    kind: "leaderboard",
    description: "A companion benchmark for agentic terminal/CLI task completion, used elsewhere in this repo's eval suite.",
  },
  {
    title: "Harbor",
    url: "https://www.harborframework.com/",
    kind: "tool",
    description:
      "The harness our runner uses to execute agents against benchmark tasks and score the resulting patches. Source: https://github.com/harbor-framework/harbor.",
  },
];
