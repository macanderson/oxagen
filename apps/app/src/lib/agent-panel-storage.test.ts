// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAgentPanelPosition,
  setAgentPanelPosition,
} from './agent-panel-storage';

describe('agent-panel-storage', () => {
  const workspaceId = 'test-workspace-123';

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    // Clear localStorage after each test
    localStorage.clear();
  });

  describe('setAgentPanelPosition', () => {
    it('should store position in localStorage', () => {
      setAgentPanelPosition(workspaceId, 100, 200);

      const stored = localStorage.getItem(
        `agent-panel-position:${workspaceId}`,
      );
      expect(stored).toBeDefined();
      expect(stored).not.toBeNull();
    });

    it('should store x and y coordinates as JSON', () => {
      setAgentPanelPosition(workspaceId, 150, 250);

      const stored = localStorage.getItem(
        `agent-panel-position:${workspaceId}`,
      );
      const parsed = JSON.parse(stored!);
      expect(parsed).toEqual({ x: 150, y: 250 });
    });

    it('should overwrite previous position', () => {
      setAgentPanelPosition(workspaceId, 100, 200);
      setAgentPanelPosition(workspaceId, 300, 400);

      const stored = localStorage.getItem(
        `agent-panel-position:${workspaceId}`,
      );
      const parsed = JSON.parse(stored!);
      expect(parsed).toEqual({ x: 300, y: 400 });
    });

    it('should handle different workspace IDs independently', () => {
      const ws1 = 'workspace-1';
      const ws2 = 'workspace-2';

      setAgentPanelPosition(ws1, 100, 200);
      setAgentPanelPosition(ws2, 300, 400);

      const stored1 = localStorage.getItem(`agent-panel-position:${ws1}`);
      const stored2 = localStorage.getItem(`agent-panel-position:${ws2}`);

      expect(JSON.parse(stored1!)).toEqual({ x: 100, y: 200 });
      expect(JSON.parse(stored2!)).toEqual({ x: 300, y: 400 });
    });
  });

  describe('getAgentPanelPosition', () => {
    it('should return null if no position is stored', () => {
      const position = getAgentPanelPosition(workspaceId);
      expect(position).toBeNull();
    });

    it('should return stored position', () => {
      setAgentPanelPosition(workspaceId, 100, 200);

      const position = getAgentPanelPosition(workspaceId);
      expect(position).toEqual({ x: 100, y: 200 });
    });

    it('should return correct position after multiple writes', () => {
      setAgentPanelPosition(workspaceId, 100, 200);
      setAgentPanelPosition(workspaceId, 500, 600);

      const position = getAgentPanelPosition(workspaceId);
      expect(position).toEqual({ x: 500, y: 600 });
    });

    it('should handle different workspace IDs independently', () => {
      const ws1 = 'workspace-1';
      const ws2 = 'workspace-2';

      setAgentPanelPosition(ws1, 100, 200);
      setAgentPanelPosition(ws2, 300, 400);

      expect(getAgentPanelPosition(ws1)).toEqual({ x: 100, y: 200 });
      expect(getAgentPanelPosition(ws2)).toEqual({ x: 300, y: 400 });
    });

    it('should return null for different workspace when data only exists for one', () => {
      setAgentPanelPosition(workspaceId, 100, 200);

      const position = getAgentPanelPosition('different-workspace');
      expect(position).toBeNull();
    });

    it('should handle corrupted JSON gracefully', () => {
      localStorage.setItem(
        `agent-panel-position:${workspaceId}`,
        'invalid json {',
      );

      const position = getAgentPanelPosition(workspaceId);
      expect(position).toBeNull();
    });

    it('should handle missing x or y properties', () => {
      localStorage.setItem(
        `agent-panel-position:${workspaceId}`,
        JSON.stringify({ x: 100 }),
      );

      const position = getAgentPanelPosition(workspaceId);
      expect(position).toBeNull();
    });
  });
});
