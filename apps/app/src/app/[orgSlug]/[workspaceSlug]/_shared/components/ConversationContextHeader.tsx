'use client';

import React, { useState } from 'react';
import { ChevronDown, GitBranch, Zap, Brain } from 'lucide-react';

export interface ConversationContextHeaderProps {
  pinnedRepo?: {
    owner: string;
    repo: string;
    branch: string;
  };
  environment?: {
    name: string;
    slug: string;
  };
  recalledMemoryCount?: number;
  onMemoryClick?: () => void;
  onRepoClick?: () => void;
}

/**
 * ConversationContextHeader
 *
 * Displays persistent context about the current conversation:
 * - Pinned repository and branch
 * - Active environment
 * - Count of recalled memories
 *
 * All badges are collapsible and expand inline without navigation.
 * Uses subtle styling (slate/gray) to avoid visual dominance.
 */
export function ConversationContextHeader({
  pinnedRepo,
  environment,
  recalledMemoryCount = 0,
  onMemoryClick,
  onRepoClick,
}: ConversationContextHeaderProps) {
  const [expandedBadge, setExpandedBadge] = useState<string | null>(null);

  const toggleBadge = (badge: string) => {
    setExpandedBadge(expandedBadge === badge ? null : badge);
  };

  return (
    <div
      className="border-b border-slate-200 bg-slate-50 px-4 py-3"
      role="region"
      aria-label="Conversation context"
    >
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center gap-2">
          {/* Repository Badge */}
          {pinnedRepo && (
            <button
              onClick={() => {
                toggleBadge('repo');
                onRepoClick?.();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              aria-label={`Pinned repository: ${pinnedRepo.owner}/${pinnedRepo.repo} on branch ${pinnedRepo.branch}`}
            >
              <GitBranch className="h-4 w-4 text-slate-500" />
              <span className="hidden sm:inline">
                {pinnedRepo.owner}/{pinnedRepo.repo}
              </span>
              <span className="sm:hidden">{pinnedRepo.repo}</span>
              <span className="text-slate-500">@{pinnedRepo.branch}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                  expandedBadge === 'repo' ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}

          {/* Environment Badge */}
          {environment && (
            <button
              onClick={() => toggleBadge('env')}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              aria-label={`Active environment: ${environment.name}`}
            >
              <Zap className="h-4 w-4 text-slate-500" />
              <span>{environment.name}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                  expandedBadge === 'env' ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}

          {/* Recalled Memory Badge */}
          {recalledMemoryCount > 0 && (
            <button
              onClick={() => {
                toggleBadge('memory');
                onMemoryClick?.();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              aria-label={`${recalledMemoryCount} recalled memories from prior sessions`}
            >
              <Brain className="h-4 w-4 text-slate-500" />
              <span>{recalledMemoryCount} memories</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                  expandedBadge === 'memory' ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}
        </div>

        {/* Expanded Details */}
        {expandedBadge === 'repo' && pinnedRepo && (
          <div className="mt-3 rounded-md bg-white p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Repository Details</p>
            <p className="mt-1">
              <strong>{pinnedRepo.owner}/{pinnedRepo.repo}</strong>
            </p>
            <p className="text-slate-500">Branch: {pinnedRepo.branch}</p>
            <p className="mt-2 text-xs text-slate-500">
              Commands like /pr, /diff, and /ci will target this repository.
            </p>
          </div>
        )}

        {expandedBadge === 'env' && environment && (
          <div className="mt-3 rounded-md bg-white p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Environment</p>
            <p className="mt-1">{environment.name}</p>
            <p className="text-slate-500">Slug: {environment.slug}</p>
            <p className="mt-2 text-xs text-slate-500">
              Sandbox and secrets are scoped to this environment.
            </p>
          </div>
        )}

        {expandedBadge === 'memory' && recalledMemoryCount > 0 && (
          <div className="mt-3 rounded-md bg-white p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Recalled Memories</p>
            <p className="mt-1">
              {recalledMemoryCount} lessons from prior sessions are active and
              influencing this conversation.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              These include rules, observations, and facts learned in earlier
              sessions. Click &quot;Memory&quot; in the sidebar to review.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
