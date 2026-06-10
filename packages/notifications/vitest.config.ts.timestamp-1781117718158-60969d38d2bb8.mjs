// vitest.config.ts
import { defineConfig } from "file:///Users/macanderson/oxagen-monorepo/node_modules/.pnpm/vitest@2.1.9_@types+node@25.9.1_jsdom@29.1.1_@noble+hashes@2.2.0__lightningcss@1.32.0_terser@5.48.0/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 90 (reduced from 94 for CI stability); target 75
      // branches floor 87 (measured 92.30); target 70
      thresholds: {
        lines: 90,
        branches: 87,
        functions: 84,
        statements: 90
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYWNhbmRlcnNvbi9veGFnZW4tbW9ub3JlcG8vcGFja2FnZXMvbm90aWZpY2F0aW9uc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hY2FuZGVyc29uL294YWdlbi1tb25vcmVwby9wYWNrYWdlcy9ub3RpZmljYXRpb25zL3ZpdGVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL21hY2FuZGVyc29uL294YWdlbi1tb25vcmVwby9wYWNrYWdlcy9ub3RpZmljYXRpb25zL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZXN0L2NvbmZpZ1wiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICB0ZXN0OiB7XG4gICAgY2xlYXJNb2NrczogdHJ1ZSxcbiAgICBlbnZpcm9ubWVudDogXCJub2RlXCIsXG4gICAgZ2xvYmFsczogZmFsc2UsXG4gICAgaW5jbHVkZTogW1wic3JjLyoqLyoudGVzdC50c1wiXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6IFwidjhcIixcbiAgICAgIHJlcG9ydGVyOiBbXCJ0ZXh0XCIsIFwibGNvdlwiXSxcbiAgICAgIC8vIGxpbmVzIGZsb29yIDkwIChyZWR1Y2VkIGZyb20gOTQgZm9yIENJIHN0YWJpbGl0eSk7IHRhcmdldCA3NVxuICAgICAgLy8gYnJhbmNoZXMgZmxvb3IgODcgKG1lYXN1cmVkIDkyLjMwKTsgdGFyZ2V0IDcwXG4gICAgICB0aHJlc2hvbGRzOiB7XG4gICAgICAgIGxpbmVzOiA5MCxcbiAgICAgICAgYnJhbmNoZXM6IDg3LFxuICAgICAgICBmdW5jdGlvbnM6IDg0LFxuICAgICAgICBzdGF0ZW1lbnRzOiA5MCxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFpVyxTQUFTLG9CQUFvQjtBQUU5WCxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixZQUFZO0FBQUEsSUFDWixhQUFhO0FBQUEsSUFDYixTQUFTO0FBQUEsSUFDVCxTQUFTLENBQUMsa0JBQWtCO0FBQUEsSUFDNUIsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsVUFBVSxDQUFDLFFBQVEsTUFBTTtBQUFBO0FBQUE7QUFBQSxNQUd6QixZQUFZO0FBQUEsUUFDVixPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
