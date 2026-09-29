import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["infra/**", "node_modules/**", "dist/**"],
    coverage: { reporter: ["text", "json", "html"] },
  },
});
