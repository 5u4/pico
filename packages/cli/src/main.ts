#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

if (process.argv[2] === "omp") {
  if (!process.execve) {
    throw new Error("pico omp requires process.execve support on this platform");
  }
  process.execve(
    process.execPath,
    [
      process.execPath,
      fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/cli")),
      ...process.argv.slice(3),
    ],
    process.env,
  );
} else {
  await import("./commands.ts");
}
