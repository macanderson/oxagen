#!/usr/bin/env npx tsx
/**
 * Backfill historical Claude Code sessions from local transcripts to ClickHouse
 *
 * Finds all ~/.claude/projects/[cwd]/sessions/[sessionid].jsonl files
 * Parses and writes to internal.agent_executions using ANALYTICS_* env vars
 */

import https from 'https';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as fs from 'fs';

// Load .env.local for credentials
function loadEnvLocal(): void {
  const envPath = join(homedir(), '..', process.env.USER || '', 'oxagen-monorepo', '.env.local');
  const fallbackPath = join(homedir(), '.oxagen', '.env.local');
  const rootPath = join(process.cwd(), '.env.local');

  let content = '';
  for (const path of [rootPath, fallbackPath, envPath]) {
    if (fs.existsSync(path)) {
      content = readFileSync(path, 'utf-8');
      break;
    }
  }

  if (!content) return;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

interface TranscriptRow {
  timestamp?: string;
  ts?: string;
  type?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: string | Array<{ type: string; text?: string }>;
  };
}

interface SessionData {
  session_id: string;
  transcript_path: string;
  started_at: string;
  ended_at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_misses: number;
  cost_usd_micros: number;
}

function parseTranscript(filePath: string): SessionData | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    let model = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let startedAt = new Date().toISOString();
    let endedAt = new Date().toISOString();

    for (const line of lines) {
      try {
        const row: TranscriptRow = JSON.parse(line);

        const ts = row.timestamp || row.ts;
        if (typeof ts === 'string') {
          if (startedAt === new Date().toISOString()) startedAt = ts;
          endedAt = ts;
        }

        if (row.type === 'assistant') {
          const message = row.message || {};
          if (!model && message.model) {
            model = String(message.model);
          }
          const usage = message.usage || {};
          inputTokens += Number(usage.input_tokens) || 0;
          outputTokens += Number(usage.output_tokens) || 0;
          cacheCreationTokens += Number(usage.cache_creation_input_tokens) || 0;
          cacheReadTokens += Number(usage.cache_read_input_tokens) || 0;
        }
      } catch {
        // Skip malformed lines
      }
    }

    const cacheMisses = Math.max(0, inputTokens - cacheReadTokens);
    const costUsdMicros = estimateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

    return {
      session_id: filePath.split('/').pop()?.replace('.jsonl', '') || 'unknown',
      transcript_path: filePath,
      started_at: startedAt,
      ended_at: endedAt,
      model: model || 'unknown',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cacheReadTokens,
      cache_misses: cacheMisses,
      cost_usd_micros: costUsdMicros,
    };
  } catch {
    return null;
  }
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const rates: Record<string, { input: number; output: number }> = {
    'claude-opus-4': { input: 15.0, output: 75.0 },
    'claude-opus-4-8': { input: 15.0, output: 75.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  };

  const base = Object.entries(rates).find(([key]) => model.includes(key))?.[1] || { input: 3.0, output: 15.0 };

  const inputCost = (inputTokens / 1_000_000) * base.input * 1_000_000;
  const outputCost = (outputTokens / 1_000_000) * base.output * 1_000_000;
  const cacheCreateCost = (cacheCreationTokens / 1_000_000) * base.input * 1.25 * 1_000_000;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * base.input * 0.1 * 1_000_000;

  return Math.round(inputCost + outputCost + cacheCreateCost + cacheReadCost);
}

function findSessionFiles(startPath: string): string[] {
  const sessions: string[] = [];

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const path = join(dir, entry);
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) {
            walk(path);
          } else if (entry.endsWith('.jsonl')) {
            sessions.push(path);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(startPath);
  return sessions;
}

function writeToClickHouse(data: SessionData[]): Promise<{ success: boolean; error?: string }> {
  return new Promise(resolve => {
    const url = process.env.ANALYTICS_URL || '';
    const user = process.env.ANALYTICS_USER || '';
    const password = process.env.ANALYTICS_PASSWORD || '';
    const database = process.env.ANALYTICS_DATABASE || 'internal';

    if (!url || !user || !password || data.length === 0) {
      resolve({ success: !user ? false : true, error: !user ? 'Missing credentials' : undefined });
      return;
    }

    const values = data
      .map(d => {
        const sessionId = d.session_id.replace(/'/g, "\\'");
        return `(
          now(),
          'claude_code_transcript',
          '${process.env.USER || 'unknown'}@localhost',
          '${d.model.replace(/'/g, "\\'")}',
          ${d.input_tokens},
          ${d.output_tokens},
          ${d.cached_tokens},
          ${d.cache_misses},
          0,
          'completed',
          '[]',
          '${sessionId}',
          '${sessionId}',
          'anthropic',
          'claude-code',
          '',
          '',
          now()
        )`;
      })
      .join(',');

    const sql = `
      INSERT INTO ${database}.agent_executions (
        timestamp,
        type,
        user_email,
        model,
        tokens_in,
        tokens_out,
        cached_tokens,
        cache_misses,
        duration_ms,
        status,
        files_modified,
        session_id,
        conversation_id,
        provider,
        surface,
        session_recap,
        prompt_hash,
        recap_generated_at
      ) VALUES ${values}
    `;

    const urlObj = new URL(url);
    urlObj.searchParams.set('query', sql);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + '?' + urlObj.searchParams.toString(),
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${responseData.slice(0, 100)}` });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.end();
  });
}

async function main(): Promise<void> {
  const projectsDir = join(homedir(), '.claude', 'projects');

  console.log(`🔍 Scanning for session files in ${projectsDir}...`);
  const sessionFiles = findSessionFiles(projectsDir);

  if (sessionFiles.length === 0) {
    console.log('✓ No session files found');
    return;
  }

  console.log(`✓ Found ${sessionFiles.length} session files\n`);

  const sessions: SessionData[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const file of sessionFiles) {
    const data = parseTranscript(file);
    if (data) {
      sessions.push(data);
      parsed++;
    } else {
      skipped++;
    }
  }

  console.log(`📊 Parsed: ${parsed} sessions, Skipped: ${skipped} (invalid/empty)\n`);

  if (sessions.length === 0) {
    console.log('✓ No valid sessions to backfill');
    return;
  }

  console.log(`📤 Backfilling ${sessions.length} sessions to ClickHouse...`);

  // Batch in groups of 100 to avoid oversized inserts
  const batchSize = 100;
  let written = 0;
  let failed = 0;

  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);
    const result = await writeToClickHouse(batch);
    if (result.success) {
      written += batch.length;
    } else {
      failed += batch.length;
      console.error(`  ❌ Batch ${Math.floor(i / batchSize) + 1} failed: ${result.error}`);
    }
    console.log(`  ${written}/${sessions.length} sessions written (${failed} failed)`);
  }

  console.log(`\n✅ Backfill complete!`);
  console.log(`\nSummary:`);
  console.log(`- Sessions backfilled: ${sessions.length}`);
  console.log(`- Total input tokens: ${sessions.reduce((sum, s) => sum + s.input_tokens, 0)}`);
  console.log(`- Total output tokens: ${sessions.reduce((sum, s) => sum + s.output_tokens, 0)}`);
  console.log(`- Total cost (µ$): ${sessions.reduce((sum, s) => sum + s.cost_usd_micros, 0)}`);
}

main().catch(error => {
  console.error('❌ Backfill failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
