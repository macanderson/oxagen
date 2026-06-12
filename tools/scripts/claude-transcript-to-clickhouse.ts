#!/usr/bin/env npx tsx
/**
 * Claude Code SessionEnd hook → ClickHouse telemetry
 *
 * Reads the session transcript from ~/.claude/projects/<cwd>/<session-id>.jsonl
 * Extracts: prompts, tokens (input/output/cache), model, cost, files
 * Async POSTs to ClickHouse internal.agent_executions
 *
 * Uses ANALYTICS_* env vars (URL, USER, PASSWORD, DATABASE)
 * Fire-and-forget: never blocks the session
 */

import https from 'https';
import { readFileSync } from 'fs';

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
  cwd: string;
  transcript_path: string;
  started_at: string;
  ended_at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_misses: number;
  cost_usd_micros: number;
  files_modified: string[];
  user_prompts: string[];
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
    const userPrompts: string[] = [];
    const filesModified: Set<string> = new Set();

    for (const line of lines) {
      try {
        const row: TranscriptRow = JSON.parse(line);

        // Capture timestamps
        const ts = row.timestamp || row.ts;
        if (typeof ts === 'string') {
          if (startedAt === new Date().toISOString()) startedAt = ts;
          endedAt = ts;
        }

        // User prompts
        if (row.type === 'user') {
          const message = row.message || {};
          let text = '';
          const content = message.content;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text)
              .join('');
          }
          if (text.trim() && !text.startsWith('<system-reminder>')) {
            userPrompts.push(text.trim());
          }
        }

        // Token usage
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

    // Estimate cache misses (total API calls - cache hits)
    // For simplicity: cache_misses = number of assistant turns without cache reads
    const cacheMisses = Math.max(0, inputTokens - cacheReadTokens);

    // Calculate cost (published rates)
    const costUsdMicros = estimateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

    return {
      session_id: extractSessionId(filePath),
      cwd: process.cwd(),
      transcript_path: filePath,
      started_at: startedAt,
      ended_at: endedAt,
      model: model || 'unknown',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cacheReadTokens,
      cache_misses: cacheMisses,
      cost_usd_micros: costUsdMicros,
      files_modified: Array.from(filesModified),
      user_prompts: userPrompts,
    };
  } catch {
    return null;
  }
}

function extractSessionId(filePath: string): string {
  // Last component before .jsonl
  return filePath.split('/').pop()?.replace('.jsonl', '') || 'unknown';
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

function writeToClickHouse(data: SessionData): Promise<void> {
  return new Promise<void>(resolve => {
    const url = process.env.ANALYTICS_URL || '';
    const user = process.env.ANALYTICS_USER || '';
    const password = process.env.ANALYTICS_PASSWORD || '';
    const database = process.env.ANALYTICS_DATABASE || 'internal';

    if (!url || !user || !password) {
      resolve();
      return;
    }

    // Escape SQL strings
    const escapeSql = (s: string) => s.replace(/'/g, "\\'");
    const filesJson = JSON.stringify(data.files_modified).replace(/'/g, "\\'");
    const promptsJson = JSON.stringify(data.user_prompts.slice(-5)).replace(/'/g, "\\'");

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
      ) VALUES (
        now(),
        'claude_code_transcript',
        '${process.env.USER || 'unknown'}@localhost',
        '${escapeSql(data.model)}',
        ${data.input_tokens},
        ${data.output_tokens},
        ${data.cached_tokens},
        ${data.cache_misses},
        0,
        'completed',
        '${filesJson}',
        '${data.session_id}',
        '${data.session_id}',
        'anthropic',
        'claude-code',
        '${promptsJson}',
        '',
        now()
      )
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
      res.on('data', () => {}); // Drain
      res.on('end', () => {
        resolve();
      });
    });

    req.on('error', () => resolve());
    req.end();
  });
}

async function main(): Promise<void> {
  // Parse stdin hook event
  let transcriptPath = '';

  if (!process.stdin.isTTY) {
    try {
      const data = await new Promise<string>((resolve) => {
        let buffer = '';
        process.stdin.on('data', chunk => buffer += chunk);
        process.stdin.on('end', () => resolve(buffer));
      });

      if (data.trim()) {
        const event = JSON.parse(data);
        transcriptPath = event.transcript_path || '';
      }
    } catch {
      // No valid JSON on stdin
    }
  }

  // Parse transcript and write to ClickHouse (async, fire-and-forget)
  if (transcriptPath) {
    const sessionData = parseTranscript(transcriptPath);
    if (sessionData) {
      void writeToClickHouse(sessionData); // Async, fire-and-forget
    }
  }
}

main().catch(() => {});
