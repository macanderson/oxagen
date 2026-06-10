import https from 'https';
import { ANALYTICS_URL, ANALYTICS_USER, ANALYTICS_PASSWORD, ANALYTICS_DATABASE } from './clickhouse-analytics-config';

interface TelemetryData {
  userEmail?: string;
  sessionId?: string;
  model: string;
  prompt: string;
  tokensIn: number;
  tokensOut: number;
  cacheTokensRead: number;
  cacheTokensCreated: number;
  filesModified: string[];
  durationMs: number;
  status?: 'success' | 'error';
}

async function writeTelemetry(data: TelemetryData): Promise<void> {
  return new Promise((resolve, reject) => {
    const filesJson = JSON.stringify(data.filesModified);

    const insertSql = `
      INSERT INTO ${ANALYTICS_DATABASE}.agent_executions (
        type,
        user_email,
        session_id,
        model,
        prompt,
        tokens_in,
        tokens_out,
        cache_tokens_read,
        cache_tokens_created,
        files_modified,
        duration_ms,
        status
      ) VALUES (
        'claude_code',
        '${data.userEmail || 'unknown'}',
        '${data.sessionId || ''}',
        '${data.model.replace(/'/g, "\\'")}',
        '${data.prompt.replace(/'/g, "\\'")}',
        ${data.tokensIn},
        ${data.tokensOut},
        ${data.cacheTokensRead},
        ${data.cacheTokensCreated},
        ${filesJson},
        ${data.durationMs},
        '${data.status || 'success'}'
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
