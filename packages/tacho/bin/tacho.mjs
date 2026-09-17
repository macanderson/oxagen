#!/usr/bin/env node
// Development shim: loads the TypeScript source through tsx's API.
// `module.register("tsx/esm")` stopped working in tsx 4.22 on Node 24
// ("tsx must be loaded with --import instead of --loader"). The published
// package ships dist-standalone/tacho.mjs, a single bundled file, instead.
import { register } from "tsx/esm/api";
register();
await import("../src/cli/main.ts");
