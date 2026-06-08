import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentMemoryRecallCommand } from "../agent.memory.recall.js";
import { agentMemoryWriteCommand } from "../agent.memory.write.js";
import { videoGenerateCommand } from "../video.generate.js";
import { svgGenerateCommand } from "../svg.generate.js";
import { workspaceModelSettingsReadCommand } from "../workspace.model.settings.read.js";
import { workspaceModelSettingsWriteCommand } from "../workspace.model.settings.write.js";
import { orgMemberInviteAcceptCommand } from "../org.member.invite.accept.js";
import { pluginRegistryListCommand } from "../plugin.registry.list.js";
import { pluginCatalogBrowseCommand } from "../plugin.catalog.browse.js";
import { pluginCredentialReauthCommand } from "../plugin.credential.reauth.js";
import { imageGenerateCommand } from "../image.generate.js";
import { documentsGenerateCommand } from "../documents.generate.js";
import { pluginRegistryAddCommand } from "../plugin.registry.add.js";

describe("CLI Command Parity Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Agent Memory Commands", () => {
    it("agent.memory.recall command exists and is configured", () => {
      expect(agentMemoryRecallCommand).toBeDefined();
      expect(agentMemoryRecallCommand.name()).toBe("recall");
    });

    it("agent.memory.write command exists and is configured", () => {
      expect(agentMemoryWriteCommand).toBeDefined();
      expect(agentMemoryWriteCommand.name()).toBe("write");
    });
  });

  describe("Generation Commands", () => {
    it("video.generate command exists and is configured", () => {
      expect(videoGenerateCommand).toBeDefined();
      expect(videoGenerateCommand.name()).toBe("generate");
    });

    it("svg.generate command exists and is configured", () => {
      expect(svgGenerateCommand).toBeDefined();
      expect(svgGenerateCommand.name()).toBe("generate");
    });

    it("image.generate command exists and is configured", () => {
      expect(imageGenerateCommand).toBeDefined();
      expect(imageGenerateCommand.name()).toBe("generate");
    });

    it("documents.generate command exists and is configured", () => {
      expect(documentsGenerateCommand).toBeDefined();
      expect(documentsGenerateCommand.name()).toBe("generate");
    });
  });

  describe("Workspace Commands", () => {
    it("workspace.model.settings.read command exists", () => {
      expect(workspaceModelSettingsReadCommand).toBeDefined();
      expect(workspaceModelSettingsReadCommand.name()).toBe("read");
    });

    it("workspace.model.settings.write command exists", () => {
      expect(workspaceModelSettingsWriteCommand).toBeDefined();
      expect(workspaceModelSettingsWriteCommand.name()).toBe("write");
    });
  });

  describe("Organization Member Commands", () => {
    it("org.member.invite.accept command exists", () => {
      expect(orgMemberInviteAcceptCommand).toBeDefined();
      expect(orgMemberInviteAcceptCommand.name()).toBe("accept");
    });
  });

  describe("Plugin Commands", () => {
    it("plugin.registry.list command exists", () => {
      expect(pluginRegistryListCommand).toBeDefined();
      expect(pluginRegistryListCommand.name()).toBe("list");
    });

    it("plugin.registry.add command exists", () => {
      expect(pluginRegistryAddCommand).toBeDefined();
      expect(pluginRegistryAddCommand.name()).toBe("add");
    });

    it("plugin.catalog.browse command exists", () => {
      expect(pluginCatalogBrowseCommand).toBeDefined();
      expect(pluginCatalogBrowseCommand.name()).toBe("browse");
    });

    it("plugin.credential.reauth command exists", () => {
      expect(pluginCredentialReauthCommand).toBeDefined();
      expect(pluginCredentialReauthCommand.name()).toBe("reauth");
    });
  });

  describe("CLI Parity Coverage", () => {
    const commands = [
      { name: "agent.memory.recall", command: agentMemoryRecallCommand },
      { name: "agent.memory.write", command: agentMemoryWriteCommand },
      { name: "video.generate", command: videoGenerateCommand },
      { name: "svg.generate", command: svgGenerateCommand },
      { name: "workspace.model.settings.read", command: workspaceModelSettingsReadCommand },
      { name: "workspace.model.settings.write", command: workspaceModelSettingsWriteCommand },
      { name: "org.member.invite.accept", command: orgMemberInviteAcceptCommand },
      { name: "plugin.registry.list", command: pluginRegistryListCommand },
      { name: "plugin.registry.add", command: pluginRegistryAddCommand },
      { name: "plugin.catalog.browse", command: pluginCatalogBrowseCommand },
      { name: "plugin.credential.reauth", command: pluginCredentialReauthCommand },
      { name: "image.generate", command: imageGenerateCommand },
      { name: "documents.generate", command: documentsGenerateCommand },
    ];

    it("all CLI parity commands are properly registered", () => {
      commands.forEach(({ name, command }) => {
        expect(command).toBeDefined();
        expect(command.name()).toBeTruthy();
      });
    });

    it("each command has a description", () => {
      commands.forEach(({ command }) => {
        expect((command as any)._description).toBeTruthy();
      });
    });
  });
});
