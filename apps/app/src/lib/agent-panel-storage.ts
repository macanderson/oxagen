/**
 * Agent panel position persistence helpers using localStorage.
 * Stores and retrieves the x,y coordinates of the draggable agent panel
 * scoped to a workspace.
 */

interface Position {
  x: number;
  y: number;
}

const STORAGE_PREFIX = 'agent-panel-position';

/**
 * Get the stored position of the agent panel for a workspace.
 * Returns null if no position is stored or if the stored data is invalid.
 */
export function getAgentPanelPosition(
  workspaceId: string,
): Position | null {
  try {
    const key = `${STORAGE_PREFIX}:${workspaceId}`;
    const stored = localStorage.getItem(key);

    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored);

    // Validate the parsed object has both required properties
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number'
    ) {
      return { x: parsed.x, y: parsed.y };
    }

    return null;
  } catch {
    // If JSON parsing fails or any other error occurs, return null
    return null;
  }
}

/**
 * Store the position of the agent panel for a workspace.
 * Overwrites any existing position.
 */
export function setAgentPanelPosition(
  workspaceId: string,
  x: number,
  y: number,
): void {
  const key = `${STORAGE_PREFIX}:${workspaceId}`;
  const position: Position = { x, y };
  localStorage.setItem(key, JSON.stringify(position));
}
