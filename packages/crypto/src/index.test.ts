import { describe, expect, it } from "vitest";
import * as crypto from "./index";
import { decrypt, encrypt } from "./envelope";
import { lastingDecryptFailure } from "./decrypt-failure";
import {
  createIngestionCryptoAdapter,
  INGESTION_KEY_ID_ENV,
  INGESTION_KEY_ID_KMS,
  resolveIngestionCryptoAdapterForKeyId,
} from "./ingestion";
import { ENVELOPE_VERSION } from "./types";

// The package's public surface is this barrel. Callers import from
// "@oxagen/crypto", so a re-export dropped here breaks them even when every
// module's own tests pass.
describe("@oxagen/crypto public surface", () => {
  it("re-exports each value the module docs name, unchanged", () => {
    expect(crypto).toEqual({
      encrypt,
      decrypt,
      lastingDecryptFailure,
      ENVELOPE_VERSION,
      createIngestionCryptoAdapter,
      resolveIngestionCryptoAdapterForKeyId,
      INGESTION_KEY_ID_ENV,
      INGESTION_KEY_ID_KMS,
    });
  });
});
