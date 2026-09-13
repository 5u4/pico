import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { installDiagnostic, runInstallFixture } from "./browser-install.fixture.ts";

it("reports the installer's actionable failure once without executing terminal controls", async () => {
  const result = await runInstallFixture("failure");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.exitCode, 1, output);
  assert.ok(result.stderr.includes(installDiagnostic), output);
  assert.equal(output.split(installDiagnostic).length - 1, 1, output);
  assert.doesNotMatch(output, /CLI execution failed|pico\.cli\.failed/);
  for (const control of ["\u001b", "\r", "\u0007", "\u202e"]) {
    assert.equal(output.includes(control), false, "Installer output contains a terminal control");
  }
});

it("still exits successfully when the installer succeeds", async () => {
  const result = await runInstallFixture("success");

  assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "");
});
