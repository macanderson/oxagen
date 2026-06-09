import https from 'https';

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

const CLICKHOUSE_URL = 'https://xao3dt0f2y.us-east-1.aws.clickhouse.cloud:8443';
const CLICKHOUSE_USERNAME = 'default';
const CLICKHOUSE_PASSWORD = 'OL1RXiIa.jg7h';

async function writeTelemetry(data: TelemetryData): Promise<void> {
  return new Promise((resolve, reject) => {
    const filesJson = JSON.stringify(data.filesModified);

    const insertSql = `
      INSERT INTO internal.agent_executions (
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

    const url = new URL(CLICKHOUSE_URL);
    url.pathname = '/';
    url.searchParams.set('query', insertSql);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${CLICKHOUSE_USERNAME}:${CLICKHOUSE_PASSWORD}`).toString('base64')}`,
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

export { writeTelemetry, TelemetryData };
