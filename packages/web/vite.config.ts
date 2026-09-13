import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

export default defineConfig(
  () =>
    ({
      root: fileURLToPath(new URL(".", import.meta.url)),
      envDir: false,
      envPrefix: [],
      plugins: [react(), tailwindcss()],
      build: { sourcemap: false },
    }) satisfies UserConfig,
);
