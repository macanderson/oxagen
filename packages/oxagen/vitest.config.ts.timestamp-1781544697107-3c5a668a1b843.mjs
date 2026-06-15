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
      // Ratcheted after plugins phase 1 (manifest + registry + kernel gate).
      // Measured 95.39 lines / 84.12 branches / 88.67 functions. Thresholds only go up.
      thresholds: {
        lines: 95,
        branches: 84,
        functions: 88,
        statements: 95
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYWNhbmRlcnNvbi9veGFnZW4tbW9ub3JlcG8vcGFja2FnZXMvb3hhZ2VuXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvbWFjYW5kZXJzb24vb3hhZ2VuLW1vbm9yZXBvL3BhY2thZ2VzL294YWdlbi92aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYWNhbmRlcnNvbi9veGFnZW4tbW9ub3JlcG8vcGFja2FnZXMvb3hhZ2VuL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZXN0L2NvbmZpZ1wiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICB0ZXN0OiB7XG4gICAgY2xlYXJNb2NrczogdHJ1ZSxcbiAgICBlbnZpcm9ubWVudDogXCJub2RlXCIsXG4gICAgZ2xvYmFsczogZmFsc2UsXG4gICAgaW5jbHVkZTogW1wic3JjLyoqLyoudGVzdC50c1wiXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6IFwidjhcIixcbiAgICAgIHJlcG9ydGVyOiBbXCJ0ZXh0XCIsIFwibGNvdlwiXSxcbiAgICAgIC8vIFJhdGNoZXRlZCBhZnRlciBwbHVnaW5zIHBoYXNlIDEgKG1hbmlmZXN0ICsgcmVnaXN0cnkgKyBrZXJuZWwgZ2F0ZSkuXG4gICAgICAvLyBNZWFzdXJlZCA5NS4zOSBsaW5lcyAvIDg0LjEyIGJyYW5jaGVzIC8gODguNjcgZnVuY3Rpb25zLiBUaHJlc2hvbGRzIG9ubHkgZ28gdXAuXG4gICAgICB0aHJlc2hvbGRzOiB7XG4gICAgICAgIGxpbmVzOiA5NSxcbiAgICAgICAgYnJhbmNoZXM6IDg0LFxuICAgICAgICBmdW5jdGlvbnM6IDg4LFxuICAgICAgICBzdGF0ZW1lbnRzOiA5NSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE0VSxTQUFTLG9CQUFvQjtBQUV6VyxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixZQUFZO0FBQUEsSUFDWixhQUFhO0FBQUEsSUFDYixTQUFTO0FBQUEsSUFDVCxTQUFTLENBQUMsa0JBQWtCO0FBQUEsSUFDNUIsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsVUFBVSxDQUFDLFFBQVEsTUFBTTtBQUFBO0FBQUE7QUFBQSxNQUd6QixZQUFZO0FBQUEsUUFDVixPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
