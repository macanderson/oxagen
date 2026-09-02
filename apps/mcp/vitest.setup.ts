import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const envPath = join(dirname, "../../.env.local");

try {
  const envContent = readFileSync(envPath, "utf8");
  const lines = envContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!key) continue;
    const value = valueParts.join("=").trim();
    // Remove quotes if present
    const cleanValue = value.replace(/^["']|["']$/g, "");
    process.env[key] = cleanValue;
  }
} catch {
  // No .env.local — expected in CI and on a machine without local config.
  // Every value read above is optional for the unit suite (@oxagen/auth is
  // aliased to a stub in vitest.config.ts), so an unreadable file is not an
  // error worth reporting. A malformed file is swallowed here too; if a test
  // ever depends on a value from .env.local, assert on it in that test.
}
