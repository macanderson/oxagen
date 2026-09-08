/**
 * Illustrative sketch: offline Biscuit verification inside the wrapper.
 *
 * Design reference only. Shows why enforcement stays off the network:
 * verification needs only the Mint's published root public key (cached by
 * the collector) and the session's ephemeral keypair. See
 * approval-tokens.md §3 and §5.
 */

import { Biscuit, PublicKey, Authorizer } from "@biscuit-auth/biscuit-wasm";

interface VerifyInput {
  tokenB64: string;            // minted by the control plane's Mint
  mintRootKey: PublicKey;      // published, cached locally, rotatable
  sessionId: string;           // this session (bound at agent_start)
  action: { scope: string; resource: string }; // the exact action to run
  useCount: number;            // from the collector's local nonce set
}

export function verifyCapability(input: VerifyInput): void {
  const token = Biscuit.fromBase64(input.tokenB64, input.mintRootKey);
  // Signature check happens in fromBase64: Ed25519, offline, ~50µs. A token
  // replayed from another session fails here — the Mint's third-party block
  // is bound to this session's ephemeral public key (proof-of-possession).

  const authorizer = new Authorizer();
  authorizer.addFact(`current_session("${input.sessionId}")`);
  authorizer.addFact(`requested("${input.action.scope}", "${input.action.resource}")`);
  authorizer.addFact(`now(${Math.floor(Date.now() / 1000)})`);
  authorizer.addFact(`use_count(${input.useCount})`);

  // The token's own caveats (datalog checks carried inside it) then run:
  //   check if time < expires_at
  //   check if scope matches requested action
  //   check if session == current_session
  //   check if use_count < use_limit
  authorizer.addToken(token);
  authorizer.authorize(); // throws on any failed caveat → caller emits
  //                         `token_denied` and does NOT execute (fail-closed)
}
