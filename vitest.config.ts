import { defineConfig } from "vitest/config";

const textExtensions = new Set([
  ".applescript",
  ".html",
  ".jl",
  ".lark",
  ".md",
  ".py",
  ".rb",
  ".sh",
  ".txt",
]);

export const ompSourceImports = () => ({
  name: "text-imports",
  enforce: "pre" as const,
  async load(id: string) {
    const file = id.split("?", 1)[0] ?? id;
    if (!textExtensions.has(file.slice(file.lastIndexOf(".")))) return;
    return `export default ${JSON.stringify(await Bun.file(file).text())}`;
  },
  transform(code: string, id: string) {
    const file = id.split("?", 1)[0] ?? id;
    let transformed = code;
    if (transformed.includes("import.meta.dir")) {
      const slash = file.lastIndexOf("/");
      transformed = transformed.replaceAll("import.meta.dir", JSON.stringify(file.slice(0, slash)));
    }
    transformed = transformed.replace(
      /import\s+(\w+)\s+from\s+["']([^"']+)["']\s+with\s*\{\s*type:\s*["']file["']\s*\};?/g,
      (_statement, name: string, relative: string) => {
        const slash = file.lastIndexOf("/");
        const directory = `${file.slice(0, slash)}/`;
        const path = Bun.fileURLToPath(new URL(relative, Bun.pathToFileURL(directory)));
        return `const ${name} = ${JSON.stringify(path)};`;
      },
    );
    return transformed === code ? undefined : transformed;
  },
});

export default defineConfig({
  plugins: [ompSourceImports()],
  test: {
    projects: [
      {
        plugins: [ompSourceImports()],
        test: {
          name: "unit",
          include: ["{packages,apps}/*/src/**/*.test.ts"],
          testTimeout: 5_000,
        },
      },
      {
        plugins: [ompSourceImports()],
        test: {
          name: "integration",
          include: ["{packages,apps}/*/test/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
