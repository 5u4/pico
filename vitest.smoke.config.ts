import { defineConfig } from "vitest/config";
import { ompSourceImports } from "./vitest.config.ts";

export default defineConfig({
	plugins: [ompSourceImports()],
	test: {
		name: "smoke",
		include: ["smoke/**/*.smoke.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		retry: 0,
		fileParallelism: false,
	},
});
