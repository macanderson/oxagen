import https from 'https';
import { ANALYTICS_URL, ANALYTICS_USER, ANALYTICS_PASSWORD, ANALYTICS_DATABASE } from './clickhouse-analytics-config';

interface TelemetryData {
  userEmail?: string;
  conversationId?: string;
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheMisses: number;
  costUsdMicros?: number;
  durationMs: number;
  surface?: 'claude-code' | 'app' | 'api' | 'mcp';
  promptHash?: string;
}

async function writeTelemetry(data: TelemetryData): Promise<void> {
  return new Promise((resolve, reject) => {
    const insertSql = `
      INSERT INTO ${ANALYTICS_DATABASE}.agent_executions (
        conversation_id,
        user_email,
        provider,
        model,
        input_tokens,
        output_tokens,
        cached_tokens,
        cache_misses,
        cost_usd_micros,
        duration_ms,
        surface,
        prompt_hash,
        type,
        status,
        created_at
      ) VALUES (
        '${data.conversationId || '00000000-0000-0000-0000-000000000000'}',
        '${data.userEmail || 'unknown'}',
        '${data.provider || ''}',
        '${data.model.replace(/'/g, "\\'")}',
        ${data.inputTokens},
        ${data.outputTokens},
        ${data.cachedTokens},
        ${data.cacheMisses},
        ${data.costUsdMicros || 0},
        ${data.durationMs},
        '${data.surface || 'claude-code'}',
        '${data.promptHash || ''}',
        'claude_code',
        'completed',
        now()
      )
    `;

    const url = new URL(ANALYTICS_URL);
    url.pathname = '/';
    url.searchParams.set('query', insertSql);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${ANALYTICS_USER}:${ANALYTICS_PASSWORD}`).toString('base64')}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve();
        } else {
          reject(new Error(`ClickHouse insert failed (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

export type { TelemetryData };
export { writeTelemetry };
