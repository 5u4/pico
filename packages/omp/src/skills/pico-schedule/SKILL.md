---
name: pico-schedule
description: Create, inspect, update, pause, or delete pico schedules, and write or debug their Bun JavaScript script.js and prompt.md sources. Use for reminders, recurring agent tasks, and conditional automation in pico.
---

# pico schedules

Use pico's session-local `schedule_*` tools to manage schedules. They belong to the current workspace. There is no `pico schedule` CLI subcommand.

The pico daemon must be running for schedules to execute. Each definition contains `script.js`, `prompt.md`, or both. A script runs first and decides whether to skip, publish text directly, or invoke OMP. Without a script, pico sends the prompt to OMP.

## Manage a schedule

Read the current tool schema before calling it. Supply `script` and `prompt` as source text, not file paths.

- `schedule_create` takes `name`, `enabled`, `target`, `trigger`, at least one of `script` or `prompt`, and optional `scriptTimeoutMs`.
- `schedule_list` takes no arguments and includes invalid definitions in the current workspace.
- `schedule_get` takes `scheduleId` and returns the definition and complete sources.
- `schedule_update` takes `scheduleId`, `name`, `target`, `trigger`, at least one source, and optional `scriptTimeoutMs`. It replaces the whole definition and source set. Read the existing schedule first and retain every source you want to keep. Omitted sources are removed.
- `schedule_set_enabled` takes `scheduleId` and `enabled`. Use it to pause or resume without replacing the definition.
- `schedule_delete` takes `scheduleId`. It removes the definition but retains run history.

Use the ID returned by the tools. Updates preserve enabled state. Change that state with `schedule_set_enabled`.

Choose a target:

- `{"kind":"current-chat"}` reuses this chat for every run.
- `{"kind":"current-workspace"}` creates a new chat in this workspace for each run. The chat is created before the script, even if the script then skips.

Choose a trigger:

- `{"kind":"once","at":1790000000000}` uses Unix epoch milliseconds. Compute the actual requested time with an explicit time zone rather than copying this example timestamp.
- `{"kind":"cron","expression":"0 9 * * 1-5","timeZone":"Asia/Shanghai"}` runs at 09:00 on weekdays in that zone. Cron has five fields, in minute, hour, day-of-month, month, day-of-week order. Use `UTC` or an IANA zone.

Resolve an ambiguous time zone with the user before scheduling. Do not silently use the daemon machine's local zone.

For a daily prompt-only task, pass this object to `schedule_create` after choosing the user's intended time zone:

```json
{
  "name": "Daily repository review",
  "enabled": true,
  "target": { "kind": "current-chat" },
  "trigger": {
    "kind": "cron",
    "expression": "0 9 * * *",
    "timeZone": "Asia/Shanghai"
  },
  "prompt": "Inspect this repository's working tree and summarize changes that need attention. Do not modify files."
}
```

Create an unverified script with `enabled: false`. Check its output in a temporary directory before enabling it. After a mutation, use `schedule_get` to confirm the saved trigger, target, state, and sources.

## Write script.js

Write a standalone Bun JavaScript program with top-level await if needed. Pico runs an immutable copy of the script with the target chat's working directory as `process.cwd()`.

Read stdin with `JSON.parse(await Bun.stdin.text())`. Pico supplies one JSON document with these fields:

- `scheduleId` and `runId` identify this execution.
- `source.kind` is `"scheduled"`. `source.scheduledFor` is the scheduled Unix epoch time in milliseconds.
- `claimedAt` is the claim time in milliseconds.
- `target` contains `kind`, `chatId`, and `workspaceId`. Its kind is `"existing-chat"` or `"workspace-chat"`, not the tool input's `"current-chat"` or `"current-workspace"`.

The environment includes `PICO_SCHEDULE_ID`, `PICO_RUN_ID`, `PICO_CHAT_ID`, and `PICO_WORKSPACE_ID`. Pico forwards `HOME`, `PATH`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, and `LC_ALL` when present. Do not expect other daemon environment variables, API keys, or a `PICO_ROOT` variable.

Relative filesystem paths resolve from the target chat's working directory. Relative imports resolve from the script's run snapshot, not that working directory. Do not depend on sibling helper files or a local `node_modules` directory beside `script.js`. The runner is not a filesystem or network sandbox. Run only code authorized for this environment.

Write exactly one UTF-8 JSON object to stdout with this shape:

```json
{ "agent": false, "content": "Time to review the repository." }
```

Only `agent` and optional `content` are allowed. `agent` is required and boolean. If present, `content` must be a non-empty string. Omit `content` to skip without a message. Use `console.error` for logs. Do not put logs, Markdown fences, or multiple JSON objects on stdout.

Choose the decision that matches the task:

| Decision | Result |
| --- | --- |
| `{"agent":false}` | Skip without publishing. |
| `{"agent":false,"content":"..."}` | Publish the text directly without a model call. Ignore any prompt. |
| `{"agent":true}` | Send `prompt.md` to OMP. Fail if no prompt exists. |
| `{"agent":true,"content":"..."}` | Send content to OMP, followed by two newlines and `prompt.md` if present. |

An OMP run publishes its final assistant text after successful completion. Script failures and skipped runs are recorded in run history, not automatically posted as chat messages.

Exit successfully after writing the decision. A nonzero exit, timeout, invalid JSON, extra property, or stdout larger than 256 KiB fails the run. The default script timeout is 60 seconds. `scriptTimeoutMs` accepts an integer from 1 to 86,400,000 and limits only the script, not the agent run.

### Publish a reminder without a model call

Pass this program as `script`. No `prompt` is needed.

```js
const input = JSON.parse(await Bun.stdin.text());
const scheduledAt = new Date(input.source.scheduledFor).toISOString();
console.log(JSON.stringify({
	agent: false,
	content: `Repository review reminder for ${scheduledAt}.`,
}));
```

### Call the agent only when the working tree changes

Use this script with the prompt `Review the working-tree status above and inspect relevant diffs. Summarize risks without modifying files.` It reports the current status on every run with changes. It does not remember whether a previous run saw the same changes.

```js
const input = JSON.parse(await Bun.stdin.text());
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
console.error(`Schedule ${input.scheduleId}, run ${input.runId}`);
console.log(JSON.stringify(status === ""
	? { agent: false }
	: { agent: true, content: `Working-tree status:\n${status}` }));
```

To use that script without a separate prompt, include the review instruction in the returned `content`. A script-only `{"agent":true}` has no input for OMP and fails.

## Inspect execution

Prefer the schedule tools over direct definition edits. The configured pico root, which defaults to `~/.pico`, contains these paths:

- `schedules/enabled/<schedule-id>/` and `schedules/disabled/<schedule-id>/` hold `meta.json` and at least one of `script.js` or `prompt.md`. The parent directory determines enabled state. Extra files, subdirectories, and symlinks invalidate a definition.
- `schedules/runs/<schedule-id>/<run-id>/run.json` records the lifecycle and outcome.
- A run's `input/` contains the snapshotted definition and sources. Inspect these to see what actually ran after later edits.
- `script/stdin.json`, `script/stdout.bin`, `script/stderr.bin`, and `script/result.json` capture script input, output, exit status, and timeout details.
- `decision.json` records the decision. Agent runs also have `omp/request.md`, `omp/events.jsonl`, `omp/final.md`, and `omp/result.json`.

Artifacts exist only for stages the run reached. Do not edit run history to retry a task.

Schedules are not precise timers. The daemon checks at startup and roughly every 30 seconds. It does not overlap unfinished runs of the same schedule. After downtime, it considers the latest cron occurrence rather than replaying every missed occurrence. An occurrence older than two hours is marked missed. A completed one-time definition is disabled. A restart marks unfinished runs interrupted rather than replaying them.
