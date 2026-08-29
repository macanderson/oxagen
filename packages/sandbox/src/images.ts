import type { SandboxLanguage } from "./types";

// Images are digest-pinned to prevent silent tag mutation.  A mutable tag
// (e.g. node:20-alpine) may be silently replaced by a new layer at any time,
// which can introduce vulnerabilities or break the sandbox ABI without any
// code change.  Pinning to `image@sha256:<digest>` makes the exact layer set
// explicit and auditable in git history.
//
// --- How to update a digest ---
// 1. Pull the new tag:  docker pull <image>:<tag>
// 2. Read the digest from the "Digest:" line in the pull output, or run:
//      docker inspect <image>:<tag> --format '{{index .RepoDigests 0}}'
// 3. Update the `image` string below.
// 4. Commit with a message referencing the CVE or changelog that prompted
//    the update.
export interface ImageSpec {
  image: string;
  entrypoint: readonly string[];
  /** Path inside the container where the user code lands. */
  codePath: string;
  /** Bytes; size of the tmpfs mount available to user code. */
  tmpfsBytes: number;
}

export const IMAGES: Record<SandboxLanguage, ImageSpec> = {
  node: {
    // node:20-alpine
    image:
      "node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
    entrypoint: ["node", "/work/main.js"],
    codePath: "/work/main.js",
    tmpfsBytes: 64 * 1024 * 1024,
  },
  python: {
    // python:3.12-slim
    image:
      "python@sha256:090ba77e2958f6af52a5341f788b50b032dd4ca28377d2893dcf1ecbdfdfe203",
    entrypoint: ["python", "/work/main.py"],
    codePath: "/work/main.py",
    tmpfsBytes: 128 * 1024 * 1024,
  },
  shell: {
    // alpine:3.20
    image:
      "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    entrypoint: ["/bin/sh", "/work/main.sh"],
    codePath: "/work/main.sh",
    tmpfsBytes: 16 * 1024 * 1024,
  },
};
