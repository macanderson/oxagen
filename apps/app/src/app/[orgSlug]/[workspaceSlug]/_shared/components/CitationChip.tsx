'use client';

import React, { useState } from 'react';
import { Brain, Lightbulb, Zap, X } from 'lucide-react';

export interface CitationChipProps {
  type: 'memory' | 'entity' | 'capability';
  label: string;
  id?: string;
  description?: string;
  onNavigate?: (id: string) => void;
  onDismiss?: () => void;
  inline?: boolean;
}

/**
 * CitationChip
 *
 * Inline, clickable reference to recalled memories, graph entities, or capabilities.
 * - Icon-coded by type (memory=brain, entity=lightbulb, capability=zap)
 * - Hover shows tooltip with details
 * - Click navigates to entity or expands memory inline
 * - Color-coded by type (all neutral, no red/green)
 * - Optional dismiss button for inline removals
 */
export function CitationChip({
  type,
  label,
  id,
  description,
  onNavigate,
  onDismiss,
  inline = false,
}: CitationChipProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const getIcon = () => {
    switch (type) {
      case 'memory':
        return <Brain className="h-3 w-3" />;
      case 'entity':
        return <Lightbulb className="h-3 w-3" />;
      case 'capability':
        return <Zap className="h-3 w-3" />;
    }
  };

  const getColorClasses = () => {
    switch (type) {
      case 'memory':
        return 'bg-slate-100 text-slate-700 hover:bg-slate-200';
      case 'entity':
        return 'bg-slate-100 text-slate-700 hover:bg-slate-200';
      case 'capability':
        return 'bg-slate-100 text-slate-700 hover:bg-slate-200';
    }
  };

  const getTypeLabel = () => {
    switch (type) {
      case 'memory':
        return 'Recalled Memory';
      case 'entity':
        return 'Knowledge Entity';
      case 'capability':
        return 'Capability';
    }
  };

  const handleClick = () => {
    if (id && onNavigate) {
      onNavigate(id);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        onClick={handleClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors ${getColorClasses()} focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
        aria-label={`${getTypeLabel()}: ${label}`}
        title={description || label}
      >
        {getIcon()}
        <span className="max-w-xs truncate">{label}</span>
        {onDismiss && !inline && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="ml-1 hover:opacity-70"
            aria-label={`Remove ${label}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </button>

      {/* Tooltip */}
      {showTooltip && description && (
        <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 transform whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg">
          {description}
          <div className="absolute top-full left-1/2 -translate-x-1/2 transform border-4 border-transparent border-t-slate-900" />
        </div>
      )}
    </div>
  );
}

/**
 * CitationChipGroup
 *
 * Container for displaying multiple citation chips with proper spacing.
 */
export interface CitationChipGroupProps {
  chips: CitationChipProps[];
  title?: string;
  maxVisible?: number;
}

export function CitationChipGroup({
  chips,
  title,
  maxVisible = 5,
}: CitationChipGroupProps) {
  const [showAll, setShowAll] = useState(false);
  const visibleChips = showAll ? chips : chips.slice(0, maxVisible);
  const hiddenCount = chips.length - maxVisible;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {title && (
        <span className="text-xs font-semibold text-slate-600">{title}</span>
      )}
      {visibleChips.map((chip, idx) => (
        <CitationChip key={idx} {...chip} />
      ))}
      {hiddenCount > 0 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          +{hiddenCount} more
        </button>
      )}
    </div>
  );
}
