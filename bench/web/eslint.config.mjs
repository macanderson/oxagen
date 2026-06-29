// Uses the shared Next.js flat config (no-explicit-any: error, core-web-vitals,
// typescript) — see ../../eslint.next.mjs — so lint rules cannot drift from the
// other Next apps. Ignore the .next build output on top.
import nextConfig from "../../eslint.next.mjs";

const config = [...nextConfig, { ignores: [".next/**"] }];
export default config;
