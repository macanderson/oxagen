/**
 * The provider, over a known set of records, speaking the wire on stdio.
 *
 * `stdio.test.ts` spawns this and drives it with real envelopes. That is the
 * only way to check the half of the contract that is not the provider's own
 * code — the handshake reply, the correlation echo, tolerance of a malformed
 * line — because all of it lives in the SDK's runtime and only exists once a
 * process is reading a pipe.
 *
 * A fake store rather than DuckDB: the native module is an optional
 * dependency, and a suite that needs it is a suite that skips where it is
 * absent.
 */
import { runStdioProvider } from "@contextgraphprotocol/typescript-sdk";
import { createContextProvider } from "../provider";
import { FakeEpisodicStore } from "./fake-store";
import {
  FIXTURE_NAMESPACE,
  FIXTURE_VERSION,
  fixtureRecords,
} from "./fixture-data";

runStdioProvider(
  createContextProvider({
    namespace: FIXTURE_NAMESPACE,
    store: new FakeEpisodicStore(fixtureRecords()),
    version: FIXTURE_VERSION,
  }),
);
