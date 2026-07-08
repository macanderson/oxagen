/**
 * Conversation Page Usability Components
 *
 * A collection of improved UI components for the conversation and prompt page.
 * These components implement best practices for:
 * - Context awareness (pinned repo, environment, recalled memory)
 * - Tool call transparency (capability invocations with full status)
 * - Citation management (memory/entity references)
 * - Command discovery (slash command palette)
 *
 * All components follow these principles:
 * - Neutral color styling (no red/green unless for errors/success)
 * - Mobile-first responsive design
 * - Full accessibility (ARIA labels, keyboard navigation)
 * - Respects prefers-reduced-motion
 */

export { ConversationContextHeader } from './ConversationContextHeader';
export type { ConversationContextHeaderProps } from './ConversationContextHeader';

export { ToolCallCard } from './ToolCallCard';
export type { ToolCallCardProps } from './ToolCallCard';

export { CitationChip, CitationChipGroup } from './CitationChip';
export type { CitationChipProps, CitationChipGroupProps } from './CitationChip';

export {
  SlashCommandPalette,
  useSlashCommands,
} from './SlashCommandPalette';
export type {
  SlashCommand,
  SlashCommandPaletteProps,
} from './SlashCommandPalette';
