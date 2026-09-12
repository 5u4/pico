---
name: pico-schedule
description: Pico reminders, scheduled tasks, and schedule scripts.
---

# Pico schedules

Use the `schedule_*` tools. Supply `script` and `prompt` as source text.

## Choose what runs

- Use a prompt alone when every run needs the agent.
- Use a script alone for a fixed reminder or deterministic result.
- Use a script with a prompt when a cheap check can decide whether the agent has work to do.

Schedules belong to the current workspace. `current-chat` reuses this conversation. `current-workspace` creates a new chat for each run, even when the script then skips.

For one-time triggers, `at` is Unix epoch milliseconds. Cron uses five fields and an explicit IANA time zone or `UTC`. Use the user's intended zone. Ask only if it is unknown. Pico must be running, and checks roughly every 30 seconds rather than at an exact instant.

Before replacing a schedule, read it with `schedule_get` and retain the sources and custom timeout you want to keep. Updates replace them rather than merge them. Use `schedule_set_enabled` to pause or resume without replacing sources.

## Write script.js

Write a standalone Bun JavaScript program. Pico runs a snapshot with the target chat's working directory as `process.cwd()`. Relative data paths use that directory, but relative imports use the script snapshot's directory.

When needed, read run context with `JSON.parse(await Bun.stdin.text())`. It contains:

- `scheduleId`, `runId`, and `claimedAt`.
- `source.kind`, which is `"scheduled"`, and `source.scheduledFor`.
- `target.kind`, which is `"existing-chat"` or `"workspace-chat"`, plus `target.chatId` and `target.workspaceId`.

Timestamps are Unix epoch milliseconds. The environment contains `PICO_SCHEDULE_ID`, `PICO_RUN_ID`, `PICO_CHAT_ID`, and `PICO_WORKSPACE_ID`. Pico forwards only `HOME`, `PATH`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, and `LC_ALL` from its own environment when present.

Write one JSON object to stdout and exit successfully. Send logs to stderr with `console.error`. Only `agent` and optional non-empty `content` are accepted.

| Output | Result |
| --- | --- |
| `{"agent":false}` | Skip without publishing. |
| `{"agent":false,"content":"Time for a break."}` | Publish text directly. Ignore any prompt. |
| `{"agent":true}` | Send `prompt.md` to the agent. Requires a prompt. |
| `{"agent":true,"content":"Review these changes."}` | Send content to the agent, followed by two newlines and `prompt.md` if present. |

The default script timeout is 60 seconds. `scriptTimeoutMs` controls only the script, not the agent. A nonzero exit, timeout, invalid decision, or stdout larger than 256 KiB fails the run. Failures are recorded in run history, not automatically posted to the chat.

### Review only when the working tree has changes

Use this script with the prompt `Review the working-tree status above and inspect relevant diffs. Summarize risks without modifying files.` It checks the current state on each run, not changes since the previous run.

```js
const result = Bun.spawnSync(["git", "status", "--short"], {
	cwd: process.cwd(),
	stdout: "pipe",
	stderr: "pipe",
});
if (result.exitCode !== 0) {
	console.error(new TextDecoder().decode(result.stderr));
	process.exit(1);
}
const status = new TextDecoder().decode(result.stdout).trim();
console.log(JSON.stringify(status === ""
	? { agent: false }
	: { agent: true, content: `Working-tree status:\n${status}` }));
```

Run a new script in a temporary directory with representative inputs before enabling its schedule. Check stdout and exit status. A script can affect real files and external services, so use disposable inputs rather than the user's live data.
