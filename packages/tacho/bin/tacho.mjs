#!/usr/bin/env node
// Development shim: loads the TypeScript source through tsx. The published
// package ships dist-standalone/tacho.mjs, a single bundled file, instead.
import { register } from "node:module";
register("tsx/esm", import.meta.url);
await import("../src/cli/main.ts");
