import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { build as viteBuild } from "vite";
import configuration from "../vite.config.ts";

export interface Asset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface Assets {
  readonly index: Asset;
  readonly files: ReadonlyMap<`/${string}`, Asset>;
}

export class AssetBuildError extends Schema.TaggedError<AssetBuildError>()("AssetBuildError", {
  message: Schema.String,
}) {}

// The daemon compiles the current browser application once during each acquisition.
export const build = Effect.fn("WebAssets.build")(function* () {
  return yield* Effect.tryPromise({
    try: async (): Promise<Assets> => {
      const config = configuration({ command: "build", mode: "production" });
      const result = await viteBuild({
        ...config,
        configFile: false,
        envDir: false,
        envPrefix: [],
        publicDir: false,
        logLevel: "silent",
        build: { ...config.build, write: false, sourcemap: false, watch: null },
      });
      if ("close" in result) {
        await result.close();
        throw new Error("Web asset build unexpectedly started a watcher");
      }
      const files = new Map<`/${string}`, Asset>();
      const encoder = new TextEncoder();
      for (const bundle of Array.isArray(result) ? result : [result]) {
        for (const output of bundle.output) {
          const source = output.type === "chunk" ? output.code : output.source;
          files.set(`/${output.fileName}`, {
            body: typeof source === "string" ? encoder.encode(source) : source,
            contentType: Bun.file(output.fileName).type || "application/octet-stream",
          });
        }
      }
      const index = files.get("/index.html");
      if (index === undefined) throw new Error("Web build did not produce index.html");
      files.set("/interface-study.svg", {
        body: await Bun.file(new URL("../public/interface-study.svg", import.meta.url)).bytes(),
        contentType: "image/svg+xml",
      });
      return { index, files };
    },
    catch: () => new AssetBuildError({ message: "Could not build the Web application" }),
  }).pipe(Effect.uninterruptible);
});
