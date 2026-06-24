// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPanel } from './agent-panel';

// Mock the hooks
vi.mock('@/hooks/use-agent-panel-position', () => ({
  useAgentPanelPosition: vi.fn(),
}));

vi.mock('@/hooks/use-agent-panel-config', () => ({
  useAgentPanelConfig: vi.fn(),
}));

// Import the mocked modules
import * as positionHooks from '@/hooks/use-agent-panel-position';
import * as configHooks from '@/hooks/use-agent-panel-config';

describe('AgentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    vi.mocked(positionHooks.useAgentPanelPosition).mockReturnValue({
      x: 100,
      y: 200,
      setPosition: vi.fn(),
      onPointerDown: vi.fn(),
      isInitialized: true,
    } as any);

    vi.mocked(configHooks.useAgentPanelConfig).mockReturnValue({
      buttonLocation: 'lower-right',
      setButtonLocation: vi.fn(),
    } as any);
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={false}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.agent-panel')).not.toBeInTheDocument();
  });

  it('should render the header with title when isOpen is true', () => {
    render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    const header = screen.getByRole('heading', { level: 2 });
    expect(header).toBeInTheDocument();
    expect(header).toHaveTextContent('Agent');
  });

  it('should render the close button when isOpen is true', () => {
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    const closeButton = container.querySelector('.agent-panel-close');
    expect(closeButton).toBeInTheDocument();
    expect(closeButton?.getAttribute('aria-label')).toBe('Close agent panel');
  });

  it('should call onClose when the close button is clicked', () => {
    const mockOnClose = vi.fn();
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={mockOnClose}
      />
    );

    const closeButton = container.querySelector('.agent-panel-close') as HTMLButtonElement;
    closeButton?.click();

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should apply correct positioning styles', () => {
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    const panel = container.querySelector('.agent-panel') as HTMLElement;
    expect(panel).toHaveStyle('left: 100px');
    expect(panel).toHaveStyle('top: 200px');
  });

  it('should render content area', () => {
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    const content = container.querySelector('.agent-panel-content');
    expect(content).toBeInTheDocument();
  });

  it('should have data-agent-panel-header attribute on header', () => {
    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    const header = container.querySelector('[data-agent-panel-header]');
    expect(header).toBeInTheDocument();
  });

  it('should not render when isInitialized is false', () => {
    vi.mocked(positionHooks.useAgentPanelPosition).mockReturnValueOnce({
      x: 100,
      y: 200,
      setPosition: vi.fn(),
      onPointerDown: vi.fn(),
      isInitialized: false,
    } as any);

    const { container } = render(
      <AgentPanel
        workspaceId="test-workspace"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.agent-panel')).not.toBeInTheDocument();
  });
});
