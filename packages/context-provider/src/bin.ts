#!/usr/bin/env node
/**
 * Run the Context Exchange Provider as a stdio child process — the shape the
 * reference host and the conformance suite drive.
 *
 * The workspace is taken from the environment rather than from the protocol
 * because the protocol carries no tenant: one process serves one workspace,
 * and which one is a deployment decision. Both variables are required, with no
 * default, so a misconfigured process refuses at startup instead of serving a
 * workspace nobody chose.
 */
import { runStdioProvider } from "@contextgraphprotocol/typescript-sdk";
import { createStore } from "@oxagen/engram/store";
import { createContextProvider } from "./provider";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(
      `${name} is required: this provider serves exactly one workspace and will not guess which.\n`,
    );
    process.exit(2);
  }
  return value;
}

const org = required("OXAGEN_CONTEXT_ORG");
const workspace = required("OXAGEN_CONTEXT_WORKSPACE");

runStdioProvider(
  createContextProvider({
    namespace: { org, workspace },
    // Defaults to an in-memory store, which answers every query with nothing.
    // That is the right default for a misconfigured process: empty, not
    // someone else's memory.
    store: createStore({ duckdbPath: process.env.ENGRAM_DUCKDB_PATH }),
  }),
);
