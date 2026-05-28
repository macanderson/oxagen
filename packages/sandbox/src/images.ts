import type { SandboxLanguage } from "./types.js";

// Pinned to a sha digest in production; tag-pinned here so local dev
// can `docker pull` without a registry round-trip.
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
    image: "node:20-alpine",
    entrypoint: ["node", "/work/main.js"],
    codePath: "/work/main.js",
    tmpfsBytes: 64 * 1024 * 1024,
  },
  python: {
    image: "python:3.12-slim",
    entrypoint: ["python", "/work/main.py"],
    codePath: "/work/main.py",
    tmpfsBytes: 128 * 1024 * 1024,
  },
  shell: {
    image: "alpine:3.20",
    entrypoint: ["/bin/sh", "/work/main.sh"],
    codePath: "/work/main.sh",
    tmpfsBytes: 16 * 1024 * 1024,
  },
};
