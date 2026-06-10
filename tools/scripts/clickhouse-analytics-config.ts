import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal(): Record<string, string> {
  const envPath = path.resolve(__dirname, '../../.env.local');
  if (!fs.existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const env = loadEnvLocal();

function get(key: string): string {
  return process.env[key] ?? env[key] ?? '';
}

const host = get('OXAGEN_ANALYTICS_HOST');
const port = get('OXAGEN_ANALYTICS_PORT') || '8443';

export const ANALYTICS_URL = host ? `https://${host}:${port}` : '';
export const ANALYTICS_USER = get('OXAGEN_ANALYTICS_USER');
export const ANALYTICS_PASSWORD = get('OXAGEN_ANALYTICS_PASSWORD');
export const ANALYTICS_DATABASE = get('OXAGEN_ANALYTICS_DATABASE') || 'internal';
