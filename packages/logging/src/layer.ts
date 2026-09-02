import type { AbsolutePath } from "@pico/contract/path";
import * as Logger from "effect/Logger";
import * as DailyFileLogger from "./daily-file-logger.ts";

export const layer = (logsDir: AbsolutePath) =>
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger, DailyFileLogger.make(logsDir)]);
