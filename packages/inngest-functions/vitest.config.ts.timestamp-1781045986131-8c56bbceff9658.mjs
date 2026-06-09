// vitest.config.ts
import { defineConfig, coverageConfigDefaults } from "file:///Users/macanderson/oxagen-monorepo/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        // Spread vitest defaults first so node_modules, test files, configs,
        // and other standard exclusions are still applied.
        ...coverageConfigDefaults.exclude,
        // Plugin-epic functions (plugin.*.ts): subject to change; no stable
        // interface contract yet. Tracked for testing in Linear OXA-1553.
        "src/functions/plugin.*.ts",
        // Pure barrel/re-export files: zero testable logic — every line is
        // a re-export that is exercised via the modules it imports.
        "src/functions.ts",
        "src/index.ts"
      ],
      // lines floor 68 (measured 73.81 pre-plugins-epic); target 75
      // branches floor 64 (measured 69.51); target 70
      // functions floor 33 (v8 arrow-attribution on rollup-usage + barrels
      //   drag it down; this floor matches reality, NOT a regression).
      // Raise all three via dedicated handler tests once plugins epic stabilises.
      thresholds: {
        lines: 68,
        branches: 64,
        functions: 33,
        statements: 68
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYWNhbmRlcnNvbi9veGFnZW4tbW9ub3JlcG8vcGFja2FnZXMvaW5uZ2VzdC1mdW5jdGlvbnNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYWNhbmRlcnNvbi9veGFnZW4tbW9ub3JlcG8vcGFja2FnZXMvaW5uZ2VzdC1mdW5jdGlvbnMvdml0ZXN0LmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFjYW5kZXJzb24vb3hhZ2VuLW1vbm9yZXBvL3BhY2thZ2VzL2lubmdlc3QtZnVuY3Rpb25zL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGNvdmVyYWdlQ29uZmlnRGVmYXVsdHMgfSBmcm9tIFwidml0ZXN0L2NvbmZpZ1wiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICB0ZXN0OiB7XG4gICAgY2xlYXJNb2NrczogdHJ1ZSxcbiAgICBlbnZpcm9ubWVudDogXCJub2RlXCIsXG4gICAgZ2xvYmFsczogZmFsc2UsXG4gICAgaW5jbHVkZTogW1wic3JjLyoqLyoudGVzdC50c1wiXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6IFwidjhcIixcbiAgICAgIHJlcG9ydGVyOiBbXCJ0ZXh0XCIsIFwibGNvdlwiXSxcbiAgICAgIGV4Y2x1ZGU6IFtcbiAgICAgICAgLy8gU3ByZWFkIHZpdGVzdCBkZWZhdWx0cyBmaXJzdCBzbyBub2RlX21vZHVsZXMsIHRlc3QgZmlsZXMsIGNvbmZpZ3MsXG4gICAgICAgIC8vIGFuZCBvdGhlciBzdGFuZGFyZCBleGNsdXNpb25zIGFyZSBzdGlsbCBhcHBsaWVkLlxuICAgICAgICAuLi5jb3ZlcmFnZUNvbmZpZ0RlZmF1bHRzLmV4Y2x1ZGUsXG5cbiAgICAgICAgLy8gUGx1Z2luLWVwaWMgZnVuY3Rpb25zIChwbHVnaW4uKi50cyk6IHN1YmplY3QgdG8gY2hhbmdlOyBubyBzdGFibGVcbiAgICAgICAgLy8gaW50ZXJmYWNlIGNvbnRyYWN0IHlldC4gVHJhY2tlZCBmb3IgdGVzdGluZyBpbiBMaW5lYXIgT1hBLTE1NTMuXG4gICAgICAgIFwic3JjL2Z1bmN0aW9ucy9wbHVnaW4uKi50c1wiLFxuXG4gICAgICAgIC8vIFB1cmUgYmFycmVsL3JlLWV4cG9ydCBmaWxlczogemVybyB0ZXN0YWJsZSBsb2dpYyBcdTIwMTQgZXZlcnkgbGluZSBpc1xuICAgICAgICAvLyBhIHJlLWV4cG9ydCB0aGF0IGlzIGV4ZXJjaXNlZCB2aWEgdGhlIG1vZHVsZXMgaXQgaW1wb3J0cy5cbiAgICAgICAgXCJzcmMvZnVuY3Rpb25zLnRzXCIsXG4gICAgICAgIFwic3JjL2luZGV4LnRzXCIsXG4gICAgICBdLFxuICAgICAgLy8gbGluZXMgZmxvb3IgNjggKG1lYXN1cmVkIDczLjgxIHByZS1wbHVnaW5zLWVwaWMpOyB0YXJnZXQgNzVcbiAgICAgIC8vIGJyYW5jaGVzIGZsb29yIDY0IChtZWFzdXJlZCA2OS41MSk7IHRhcmdldCA3MFxuICAgICAgLy8gZnVuY3Rpb25zIGZsb29yIDMzICh2OCBhcnJvdy1hdHRyaWJ1dGlvbiBvbiByb2xsdXAtdXNhZ2UgKyBiYXJyZWxzXG4gICAgICAvLyAgIGRyYWcgaXQgZG93bjsgdGhpcyBmbG9vciBtYXRjaGVzIHJlYWxpdHksIE5PVCBhIHJlZ3Jlc3Npb24pLlxuICAgICAgLy8gUmFpc2UgYWxsIHRocmVlIHZpYSBkZWRpY2F0ZWQgaGFuZGxlciB0ZXN0cyBvbmNlIHBsdWdpbnMgZXBpYyBzdGFiaWxpc2VzLlxuICAgICAgdGhyZXNob2xkczoge1xuICAgICAgICBsaW5lczogNjgsXG4gICAgICAgIGJyYW5jaGVzOiA2NCxcbiAgICAgICAgZnVuY3Rpb25zOiAzMyxcbiAgICAgICAgc3RhdGVtZW50czogNjgsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBNlcsU0FBUyxjQUFjLDhCQUE4QjtBQUVsYSxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixZQUFZO0FBQUEsSUFDWixhQUFhO0FBQUEsSUFDYixTQUFTO0FBQUEsSUFDVCxTQUFTLENBQUMsa0JBQWtCO0FBQUEsSUFDNUIsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsVUFBVSxDQUFDLFFBQVEsTUFBTTtBQUFBLE1BQ3pCLFNBQVM7QUFBQTtBQUFBO0FBQUEsUUFHUCxHQUFHLHVCQUF1QjtBQUFBO0FBQUE7QUFBQSxRQUkxQjtBQUFBO0FBQUE7QUFBQSxRQUlBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFNQSxZQUFZO0FBQUEsUUFDVixPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
