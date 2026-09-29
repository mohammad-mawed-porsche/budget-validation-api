import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    api: "src/lambda/api.ts",
    workflow: "src/lambda/workflow.ts",
  },
  outDir: ".lambda",
  clean: true,
  bundle: true,
  format: ["cjs"],
  outExtension: () => ({ js: ".js" }),
  platform: "node",
  target: "node22",
  sourcemap: false,
  noExternal: [/^(?!argon2$).*/],
  external: ["argon2"],
});
