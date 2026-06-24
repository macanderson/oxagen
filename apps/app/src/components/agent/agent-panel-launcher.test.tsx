// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AgentPanelLauncher } from './agent-panel-launcher';

describe('AgentPanelLauncher', () => {
  const mockOnClick = vi.fn();

  describe('lower-right variant', () => {
    it('should render the button with correct classes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--lower-right');
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass('agent-panel-launcher');
    });

    it('should render the wand icon', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--lower-right');
      expect(button?.querySelector('svg')).toBeInTheDocument();
    });

    it('should call onClick when clicked', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--lower-right'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalledOnce();
    });

    it('should have correct aria attributes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--lower-right');
      expect(button?.getAttribute('aria-label')).toBe('Open agent panel');
      expect(button?.getAttribute('aria-pressed')).toBe('false');
    });

    it('should update aria-pressed when isOpen is true', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={true}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--lower-right');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('sidebar variant', () => {
    it('should render the button with correct classes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass('agent-panel-launcher');
    });

    it('should render label text with default label', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button?.textContent).toContain('Agent');
    });

    it('should render label text with custom label', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
          label="Custom Agent"
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button?.textContent).toContain('Custom Agent');
    });

    it('should render the wand icon', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button?.querySelector('svg')).toBeInTheDocument();
    });

    it('should add is-open class when isOpen is true', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={true}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button).toHaveClass('is-open');
    });

    it('should not add is-open class when isOpen is false', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button).not.toHaveClass('is-open');
    });

    it('should call onClick when clicked', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--sidebar'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalledOnce();
    });

    it('should have correct aria attributes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button?.getAttribute('aria-label')).toContain('Toggle agent panel');
      expect(button?.getAttribute('aria-pressed')).toBe('false');
    });

    it('should update aria attributes when isOpen is true', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={true}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--sidebar');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      expect(button?.getAttribute('aria-label')).toContain('open');
    });
  });

  describe('topnav variant', () => {
    it('should render the button with correct classes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--topnav');
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass('agent-panel-launcher');
    });

    it('should render the wand icon', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--topnav');
      expect(button?.querySelector('svg')).toBeInTheDocument();
    });

    it('should call onClick when clicked', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--topnav'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalledOnce();
    });

    it('should have correct aria attributes', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--topnav');
      expect(button?.getAttribute('aria-label')).toBe('Open agent panel');
      expect(button?.getAttribute('aria-pressed')).toBe('false');
    });

    it('should update aria-pressed when isOpen is true', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={true}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector('.agent-panel-launcher--topnav');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('command-palette-only variant', () => {
    it('should not render the button', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="command-palette-only"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      expect(container.querySelector('.agent-panel-launcher')).not.toBeInTheDocument();
    });

    it('should return null', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="command-palette-only"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe('onClick callback', () => {
    it('should call onClick with lower-right variant', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="lower-right"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--lower-right'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalled();
    });

    it('should call onClick with topnav variant', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="topnav"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--topnav'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalled();
    });

    it('should call onClick with sidebar variant', () => {
      const { container } = render(
        <AgentPanelLauncher
          variant="sidebar"
          isOpen={false}
          onClick={mockOnClick}
        />
      );

      const button = container.querySelector(
        '.agent-panel-launcher--sidebar'
      ) as HTMLButtonElement;
      button?.click();

      expect(mockOnClick).toHaveBeenCalled();
    });
  });
});
