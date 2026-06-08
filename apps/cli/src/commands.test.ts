import { describe, it, expect, vi, beforeEach } from "vitest";
import { authLoginCommand } from "./commands/auth.login";
import { authLogoutCommand } from "./commands/auth.logout";
import { authWhoamiCommand } from "./commands/auth.whoami";
import { orgListCommand } from "./commands/org.list";
import { workspaceListCommand } from "./commands/workspace.list";
import { chatSendCommand } from "./commands/chat.send";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CLI Commands", () => {
  describe("auth login", () => {
    it("requires email and password", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      expect(() => {
        authLoginCommand.parse(["node", "cli"]);
      }).toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("email and password are required")
      );

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("accepts email and password options", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      authLoginCommand.parse(["node", "cli", "--email", "user@example.com", "--password", "secret"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Authenticating"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("success"));

      consoleSpy.mockRestore();
    });
  });

  describe("auth logout", () => {
    it("logs out user", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      authLogoutCommand.parse(["node", "cli"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Signing out"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("success"));

      consoleSpy.mockRestore();
    });
  });

  describe("auth whoami", () => {
    it("displays current user info", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      authWhoamiCommand.parse(["node", "cli"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("User:"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Organization:"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspace:"));

      consoleSpy.mockRestore();
    });
  });

  describe("org list", () => {
    it("displays organizations", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      orgListCommand.parse(["node", "cli"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Organizations"));

      consoleSpy.mockRestore();
    });
  });

  describe("workspace list", () => {
    it("displays workspaces", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      workspaceListCommand.parse(["node", "cli"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspaces"));

      consoleSpy.mockRestore();
    });
  });

  describe("chat send", () => {
    it("accepts message argument", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation();
      chatSendCommand.parse(["node", "cli", "hello world"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Sending"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("hello world"));

      consoleSpy.mockRestore();
    });
  });
});
