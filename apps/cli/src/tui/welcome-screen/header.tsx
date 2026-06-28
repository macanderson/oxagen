/**
 * Styled header component for the welcome screen.
 * 
 * Layout:
 * - Top border (full width, styled with brand colors)
 * - OXAGEN wordmark (block letters, centered)
 * - Tagline with version and status indicators
 * - Bottom border separator
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

// Enhanced OXAGEN wordmark with decorative borders
const HEADER_ART: string[] = [
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "                                                          ",
  "   ██████  ██   ██  █████   ██████  ███████ ███    ██   ",
  "  ██    ██  ██ ██  ██   ██ ██       ██      ████   ██   ",
  "  ██    ██   ███   ███████ ██   ███ █████   ██ ██  ██   ",
  "  ██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██   ",
  "   ██████  ██   ██ ██   ██  ██████  ███████ ██   ████   ",
  "                                                          ",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
];

export interface HeaderProps {
  /** Version string (e.g. "0.6.2") */
  version: string;
  /** Optional status message to display */
  status?: string;
  /** Whether the system is connected/ready */
  connected?: boolean;
}

export function Header({
  version,
  status,
  connected = true,
}: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Wordmark with decorative borders */}
      {HEADER_ART.map((line, i) => {
        // Top and bottom borders use cyan
        if (i === 0 || i === HEADER_ART.length - 1) {
          return (
            <Text key={i} color={theme.cyan}>
              {line}
            </Text>
          );
        }
        // Wordmark uses brand violet, bold
        return (
          <Text key={i} color={theme.violet} bold>
            {line}
          </Text>
        );
      })}

      {/* Tagline with status indicators */}
      <Box marginTop={1} justifyContent="center">
        <Text color={theme.cyan}>{theme.ring} </Text>
        <Text color={theme.violet} bold>
          OXAGEN
        </Text>
        <Text dimColor> · </Text>
        <Text>Agentic Coding Assistant</Text>
        <Text dimColor> · </Text>
        <Text dimColor>v{version}</Text>
        
        {status && (
          <>
            <Text dimColor> · </Text>
            <Text color={connected ? "#10B981" : "#EF4444"}>
              {connected ? "●" : "○"} {status}
            </Text>
          </>
        )}
      </Box>
      
      {/* Subtitle */}
      <Box marginTop={1} justifyContent="center">
        <Text dimColor>Powered by the Oxagen Knowledge-Graph Context Engine</Text>
      </Box>
    </Box>
  );
}
