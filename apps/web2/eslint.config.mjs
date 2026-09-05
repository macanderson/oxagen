// Uses the shared Next.js flat config (no-explicit-any: error, …) — see
// ../../eslint.next.mjs — plus the Fumadocs-generated .source/** ignore on top.
import nextConfig from "../../eslint.next.mjs";

const config = [...nextConfig, { ignores: [".source/**"] }];
export default config;
