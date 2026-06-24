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

/**
 * Clamp x,y coordinates to the viewport bounds.
 * Ensures the draggable panel stays within the visible window.
 * @param x - The x coordinate to clamp
 * @param y - The y coordinate to clamp
 * @param panelWidth - Width of the panel (used to clamp right edge)
 * @param panelHeight - Height of the panel (used to clamp bottom edge)
 * @returns Clamped position coordinates
 */
export function clampToViewport(
  x: number,
  y: number,
  panelWidth: number,
  panelHeight: number,
): Position {
  // Clamp x to viewport width (0 to window.innerWidth - panelWidth)
  const clampedX = Math.max(0, Math.min(x, window.innerWidth - panelWidth));

  // Clamp y to viewport height (0 to window.innerHeight - panelHeight)
  const clampedY = Math.max(0, Math.min(y, window.innerHeight - panelHeight));

  return { x: clampedX, y: clampedY };
}
