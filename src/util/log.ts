import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTimeRotatingFileSink } from "@logtape/file";
import {
  ansiColorFormatter,
  configure,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
  type Logger,
} from "@logtape/logtape";

const RETENTION_DAYS = 30;

export function defaultLogDir(): string {
  return join(homedir(), ".pico", "logs");
}

export interface LoggingOptions {
  logDir?: string;
  console?: boolean;
}

export async function configureLogging(
  options: LoggingOptions = {},
): Promise<void> {
  const logDir = options.logDir ?? defaultLogDir();
  mkdirSync(logDir, { recursive: true });

  await configure({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      file: getTimeRotatingFileSink({
        directory: logDir,
        interval: "daily",
        maxAgeMs: RETENTION_DAYS * 24 * 60 * 60 * 1000,
        formatter: jsonLinesFormatter,
      }),
      console: getConsoleSink({ formatter: ansiColorFormatter }),
    },
    loggers: [
      {
        category: ["pico"],
        sinks: options.console === false ? ["file"] : ["file", "console"],
        lowestLevel: "debug",
      },
      {
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "warning",
      },
    ],
  });
}

export function log(category: readonly string[] = []): Logger {
  return getLogger(["pico", ...category]);
}
