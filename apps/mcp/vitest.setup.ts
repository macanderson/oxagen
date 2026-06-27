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
    const value = valueParts.join("=").trim();
    // Remove quotes if present
    const cleanValue = value.replace(/^["']|["']$/g, "");
    process.env[key] = cleanValue;
  }
} catch (err) {
  // .env.local not found, that's ok for CI/testing without local config
}
