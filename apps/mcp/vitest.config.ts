import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // WARNING: this is a hand-maintained allowlist, not a glob. Only the
      // files named below are measured against the thresholds; every other
      // file under src/tools/ is invisible to the coverage gate, so a new
      // tool added without tests does NOT fail this gate. Add each new tool
      // file here when you add its tests.
      //
      // Read the 85% thresholds below with that in mind: as of this writing
      // the list names 61 of the 326 tool files on disk, so "85% covered"
      // describes under a fifth of the tool surface, not the app. Two
      // auto-discovering guards cover the rest at a shallower depth —
      // src/tools/tool-registry.test.ts (a tool file exists per mcp-surfaced
      // contract, names do not collide) and src/tools.auth-gate.test.ts
      // (every tool file resolves a principal via buildContext).
      //
      // middleware.ts is deliberately absent: its module-level side effects
      // (assertRlsConnectionSafe, bootstrapIAMRuntime, setSecurityEventEmitter)
      // need the full infra stack to import. src/middleware.bootstrap.test.ts
      // guards its required startup calls by source inspection instead.
      include: [
        "src/context.ts",
        // agent tools
        "src/tools/agent.approval.resolve.ts",
        "src/tools/agent.mcp.list.ts",
        "src/tools/agent.mcp.register.ts",
        "src/tools/agent.memory.recall.ts",
        "src/tools/agent.memory.write.ts",
        "src/tools/agent.plan.approve.ts",
        "src/tools/agent.skill.list.ts",
        "src/tools/agent.skill.load.ts",
        "src/tools/agent.background_task.cancel.ts",
        "src/tools/agent.background_task.read.ts",
        "src/tools/agent.background_task.start.ts",
        "src/tools/agent.tool.list.ts",
        // billing / API key tools
        "src/tools/billing.credits.purchase.ts",
        "src/tools/billing.subscription.read.ts",
        "src/tools/billing.subscription_upgrade.start.ts",
        "src/tools/api.key.create.ts",
        "src/tools/api.key.revoke.ts",
        // conversation tools
        "src/tools/conversation.archive.ts",
        "src/tools/conversation.delete.ts",
        "src/tools/conversation.list.ts",
        "src/tools/conversation.purge.ts",
        "src/tools/conversation.rename.ts",
        "src/tools/chat.message.send.ts",
        // document / media / asset tools
        "src/tools/archive.create.ts",
        "src/tools/asset.upload.ts",
        "src/tools/document.generate.ts",
        "src/tools/document.pdf.create.ts",
        "src/tools/form.fill.ts",
        "src/tools/image.generate.ts",
        "src/tools/svg.generate.ts",
        "src/tools/video.generate.ts",
        // misc / org / workspace tools
        "src/tools/notification.list.ts",
        "src/tools/notification.mark.ts",
        "src/tools/org.member.add.ts",
        "src/tools/org.member_invite.accept.ts",
        "src/tools/org.member_invite.decline.ts",
        "src/tools/org.member.remove.ts",
        "src/tools/org.member_role.change.ts",
        "src/tools/org.create.ts",
        "src/tools/workspace.create.ts",
        "src/tools/user.preferences.read.ts",
        "src/tools/user.preferences.write.ts",
        "src/tools/workspace.model_settings.read.ts",
        "src/tools/workspace.model_settings.write.ts",
        "src/tools/system.install.instructions.ts",
        "src/tools/workflow.cancel.ts",
        "src/tools/workflow.run.ts",
        "src/tools/workflow.status.ts",
        // plugin tools
        "src/tools/plugin.catalog.browse.ts",
        "src/tools/plugin.catalog.get.ts",
        "src/tools/plugin.credential.reauth.ts",
        "src/tools/plugin.credential.set_secret.ts",
        "src/tools/plugin.org.install.ts",
        "src/tools/plugin.org.install_bulk.ts",
        "src/tools/plugin.org.list.ts",
        "src/tools/plugin.set_enabled.ts",
        "src/tools/plugin.org.uninstall.ts",
        "src/tools/plugin.registry.add.ts",
        "src/tools/plugin.registry.list.ts",
        "src/tools/plugin.registry.remove.ts",
        "src/tools/plugin.settings.set_auth_alerts.ts",
      ],
      exclude: ["src/tools/*.test.ts"],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      // The @oxagen/auth barrel eagerly re-exports ./auth, which calls
      // requireEnv(BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_LOGIN_*,
      // GITHUB_LOGIN_*, ...) at module top-level. With those env vars unset the
      // import throws before any test collects. mcp only uses resolveApiKey
      // (context.ts), invoked inside handlers — never at import time or in the
      // schema/registry tests — so stub the package to a no-op. Mirrors the
      // server-only alias in apps/app/vitest.config.ts.
      "@oxagen/auth": new URL("./src/test/auth-stub.ts", import.meta.url)
        .pathname,
    },
  },
});
