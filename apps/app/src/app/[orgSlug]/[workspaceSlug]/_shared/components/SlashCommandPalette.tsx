'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';

export interface SlashCommand {
  id: string;
  name: string;
  description: string;
  trigger: string;
  icon?: React.ReactNode;
  shortcut?: string;
  category?: string;
}

export interface SlashCommandPaletteProps {
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
  isOpen: boolean;
  searchQuery?: string;
  onClose?: () => void;
}

/**
 * SlashCommandPalette
 *
 * Searchable dropdown of available commands with keyboard navigation.
 * - Appears when user types `/` in the composer
 * - Keyboard navigation: arrow keys, Enter to select, Esc to close
 * - Fuzzy search to filter commands
 * - Organized by category
 * - Shows command name, description, and keyboard shortcut
 */
export function SlashCommandPalette({
  commands,
  onSelect,
  isOpen,
  searchQuery = '',
  onClose,
}: SlashCommandPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>(
    commands
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  // Filter commands based on search query
  useEffect(() => {
    if (!searchQuery) {
      setFilteredCommands(commands);
      setSelectedIndex(0);
      return;
    }

    const query = searchQuery.toLowerCase();
    const filtered = commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query) ||
        cmd.trigger.toLowerCase().includes(query)
    );

    setFilteredCommands(filtered);
    setSelectedIndex(0);
  }, [searchQuery, commands]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredCommands.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
            onClose?.();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, filteredCommands, onSelect, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [selectedIndex]);

  if (!isOpen || filteredCommands.length === 0) {
    return null;
  }

  // Group commands by category
  const groupedCommands = filteredCommands.reduce(
    (acc, cmd) => {
      const category = cmd.category || 'Other';
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(cmd);
      return acc;
    },
    {} as Record<string, SlashCommand[]>
  );

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
      role="listbox"
      aria-label="Slash commands"
    >
      {Object.entries(groupedCommands).map(([category, cmds]) => (
        <div key={category}>
          {/* Category Header */}
          <div className="sticky top-0 bg-slate-50 px-3 py-2">
            <p className="text-xs font-semibold uppercase text-slate-500">
              {category}
            </p>
          </div>

          {/* Commands in Category */}
          {cmds.map((cmd, idx) => {
            const globalIdx = filteredCommands.indexOf(cmd);
            const isSelected = globalIdx === selectedIndex;

            return (
              <button
                key={cmd.id}
                ref={isSelected ? selectedItemRef : null}
                onClick={() => {
                  onSelect(cmd);
                  onClose?.();
                }}
                className={`w-full px-3 py-2.5 text-left transition-colors ${
                  isSelected
                    ? 'bg-blue-50 text-blue-900'
                    : 'text-slate-900 hover:bg-slate-50'
                }`}
                role="option"
                aria-selected={isSelected}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {cmd.icon && (
                        <span className="text-slate-500">{cmd.icon}</span>
                      )}
                      <p className="font-medium">{cmd.name}</p>
                      {cmd.shortcut && (
                        <span className="ml-auto text-xs text-slate-500">
                          {cmd.shortcut}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600">
                      {cmd.description}
                    </p>
                  </div>
                  {isSelected && (
                    <ChevronRight className="h-4 w-4 text-blue-500 flex-shrink-0" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * useSlashCommands
 *
 * Hook for managing slash command state in a composer.
 */
export function useSlashCommands(commands: SlashCommand[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleInputChange = (text: string) => {
    const lastChar = text[text.length - 1];
    const hasSlash = text.includes('/');

    if (lastChar === '/' && hasSlash) {
      setIsOpen(true);
      setSearchQuery('');
    } else if (hasSlash && isOpen) {
      const slashIndex = text.lastIndexOf('/');
      const query = text.substring(slashIndex + 1);
      setSearchQuery(query);
    } else if (!hasSlash && isOpen) {
      setIsOpen(false);
      setSearchQuery('');
    }
  };

  const handleCommandSelect = (command: SlashCommand) => {
    // Return the command trigger or full command
    return command.trigger;
  };

  return {
    isOpen,
    setIsOpen,
    searchQuery,
    setSearchQuery,
    handleInputChange,
    handleCommandSelect,
  };
}
