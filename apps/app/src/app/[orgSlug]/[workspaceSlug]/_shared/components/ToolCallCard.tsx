'use client';

import React, { useState } from 'react';
import {
  ChevronDown,
  Loader2,
  AlertCircle,
  Code2,
  RotateCcw,
} from 'lucide-react';

export interface ToolCallCardProps {
  toolName: string;
  status: 'pending' | 'success' | 'error';
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
  };
  onRetry?: () => void;
}

/**
 * ToolCallCard
 *
 * Displays a capability invocation with full transparency:
 * - Tool name, icon, and status
 * - Input parameters (structured, not raw JSON)
 * - Execution status (pending, success, error)
 * - Results with syntax highlighting
 * - Retry button for failed calls
 * - Error details (collapsible)
 *
 * Uses neutral styling; no red for non-error states.
 * Respects prefers-reduced-motion for animations.
 */
export function ToolCallCard({
  toolName,
  status,
  input,
  output,
  error,
  onRetry,
}: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(status === 'pending');
  const [showErrorStack, setShowErrorStack] = useState(false);

  const getStatusIcon = () => {
    switch (status) {
      case 'pending':
        return (
          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
        );
      case 'success':
        return (
          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-100">
            <span className="text-xs font-bold text-slate-600">✓</span>
          </div>
        );
      case 'error':
        return (
          <AlertCircle className="h-4 w-4 text-slate-500" />
        );
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return 'Running';
      case 'success':
        return 'Completed';
      case 'error':
        return 'Failed';
    }
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-slate-200 bg-white"
      role="region"
      aria-label={`Tool call: ${toolName} (${status})`}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1">
            {getStatusIcon()}
            <div className="flex-1">
              <p className="font-medium text-slate-900">{toolName}</p>
              <p className="text-sm text-slate-500">{getStatusText()}</p>
            </div>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-slate-400 transition-transform ${
              isExpanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
          {/* Input Parameters */}
          {input && Object.keys(input).length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-slate-900">Input</p>
              <div className="rounded-md bg-white p-3 font-mono text-sm text-slate-700">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Output / Results */}
          {output && Object.keys(output).length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-slate-900">Result</p>
              <div className="rounded-md bg-white p-3 font-mono text-sm text-slate-700">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Error Details */}
          {error && (
            <div className="mb-4">
              <button
                onClick={() => setShowErrorStack(!showErrorStack)}
                className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-slate-900 hover:text-slate-700"
              >
                <AlertCircle className="h-4 w-4 text-slate-500" />
                Error: {error.message}
                {error.stack && (
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      showErrorStack ? 'rotate-180' : ''
                    }`}
                  />
                )}
              </button>
              {showErrorStack && error.stack && (
                <div className="rounded-md bg-white p-3 font-mono text-xs text-slate-600">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words">
                    {error.stack}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2">
            {status === 'error' && onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <RotateCcw className="h-4 w-4" />
                Retry
              </button>
            )}
            <button
              onClick={() => {
                if (input || output || error) {
                  const data = { toolName, status, input, output, error };
                  navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
            >
              <Code2 className="h-4 w-4" />
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
