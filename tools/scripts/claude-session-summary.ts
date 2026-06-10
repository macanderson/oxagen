#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface SessionSummary {
  session_id: string;
  timestamp: string;
  duration_minutes: number | null;
  user: string;
  repository: string;
  branch: string | null;
  files_changed_count: number;
  files_changed_details: string | null;
  lines_added: number;
  lines_removed: number;
  accomplishment_summary: string;
}

function safeExec(cmd: string, fallback = ''): string {
  try {
    return execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();
  } catch {
    return fallback;
  }
}

async function captureSessionSummary(): Promise<SessionSummary> {
  const now = new Date();
  const sessionId = process.env.CLAUDE_SESSION_ID || `session-${now.getTime()}`;
  const user = process.env.USER || 'unknown';

  // Get repository info
  const repoName = safeExec('git rev-parse --show-toplevel', process.cwd()).split('/').pop() || 'unknown';
  const branch = safeExec('git rev-parse --abbrev-ref HEAD', 'main');

  // Get git diff statistics
  const diffStat = safeExec('git diff --stat');
  const diffNumStat = safeExec('git diff --numstat');

  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  if (diffNumStat) {
    const lines = diffNumStat.split('\n').filter(Boolean);
    filesChanged = lines.length;
    lines.forEach(line => {
      const [added, removed] = line.split('\t');
      linesAdded += parseInt(added, 10) || 0;
      linesRemoved += parseInt(removed, 10) || 0;
    });
  }

  // Get summary from recent changes
  const changedFiles = safeExec('git diff --name-only').split('\n').filter(Boolean);
  const fileTypes = changedFiles.reduce((acc: Record<string, number>, file: string) => {
    const ext = file.split('.').pop() || 'unknown';
    acc[ext] = (acc[ext] || 0) + 1;
    return acc;
  }, {});

  const typesSummary = Object.entries(fileTypes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([ext, count]) => `${count} .${ext}`)
    .join(', ');

  // Build accomplishment summary from changes
  let accomplishmentSummary = 'Session completed';
  if (filesChanged > 0) {
    accomplishmentSummary = `Modified ${filesChanged} files (${typesSummary}): ${linesAdded} lines added, ${linesRemoved} lines removed`;
  }
  if (process.env.CLAUDE_SESSION_SUMMARY) {
    accomplishmentSummary = process.env.CLAUDE_SESSION_SUMMARY;
  }

  const summary: SessionSummary = {
    session_id: sessionId,
    timestamp: now.toISOString(),
    duration_minutes: null,
    user,
    repository: repoName,
    branch: branch || null,
    files_changed_count: filesChanged,
    files_changed_details: diffStat || null,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    accomplishment_summary: accomplishmentSummary
  };

  return summary;
}

async function postToClickHouse(summary: SessionSummary): Promise<void> {
  const analyticsUrl = process.env.ANALYTICS_URL;
  if (!analyticsUrl) {
    console.log('⚠ ANALYTICS_URL not set, skipping ClickHouse post');
    return;
  }

  try {
    const response = await fetch(`${analyticsUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Type': 'claude-code-session-summary'
      },
      body: JSON.stringify({
        event: 'claude_code_session_summary',
        timestamp: summary.timestamp,
        data: summary
      })
    });

    if (!response.ok) {
      console.error(`ClickHouse post failed: ${response.status}`);
    } else {
      console.log(`✓ Session summary recorded (${summary.session_id})`);
    }
  } catch (error) {
    // Silently fail for analytics - don't disrupt user session
    // console.error('Failed to post to ClickHouse:', error);
  }
}

async function main() {
  try {
    const summary = await captureSessionSummary();
    await postToClickHouse(summary);
  } catch (error) {
    // Silently fail for analytics
  }
}

main();
