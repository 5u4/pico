---
name: pico-schedule
description: Pico reminders, scheduled tasks, and schedule scripts.
---

# Pico schedules

Use the `schedule_*` tools for schedule metadata. Author `script.js`, `prompt.md`, and any supporting files with ordinary filesystem tools.

## Choose what runs

- Use a prompt alone when every run needs the agent.
- Use a script alone for a fixed reminder or deterministic result.
- Use a script with a prompt when a cheap check can decide whether the agent has work to do.

Schedules belong to the current workspace. `current-chat` reuses this conversation. `current-workspace` creates a new chat for each run, even when the script then skips.

For one-time triggers, `at` is Unix epoch milliseconds. Cron uses five fields and an explicit IANA time zone or `UTC`. Use the user's intended zone. Ask only if it is unknown. Pico must be running, and checks roughly every 30 seconds rather than at an exact instant.

## Create a schedule

Write the source files in a directory, then pass its absolute path as `sourceDirectory` to `schedule_create`. Supply `name`, `enabled`, `target`, and `trigger`, plus `scriptTimeoutMs` if needed.

At least one root entrypoint, `script.js` or `prompt.md`, must exist. Every entrypoint present must contain valid UTF-8 text with at least one non-whitespace character. Helpers, binary assets, nested directories, and empty directories are allowed. Symlinks and special files are rejected anywhere in the tree.

Do not author root `meta.json` or `definition.json`, including case variants such as `Meta.json` and `Definition.json`. Pico owns the exact root `meta.json` and reserves `definition.json` case-insensitively for run snapshot metadata. These names are allowed inside nested directories.

Creation copies the complete supported source tree into Pico's managed directory. Later edits to the original directory do not affect that owned copy. Put every helper and asset the script needs inside the source directory. Pico does not crawl imports or copy dependencies from outside it.

## Edit or pause a schedule

Read the schedule with `schedule_get`. The result contains the current `sourceDirectory`, not source text. Edit files in that directory with ordinary filesystem tools. Future immutable run snapshots include the edited entrypoints, helpers, assets, and directories. Existing snapshots do not change.

Invalid schedules also report `sourceDirectory` when their directory is known, so you can repair missing entrypoints, blank prompts, or unsupported files in place. A conflicted schedule has `sourceDirectory: null` because it exists in both state directories.

Use `schedule_update` for metadata. Supply only the fields you want to change: `name`, `enabled`, `target`, `trigger`, or `scriptTimeoutMs`. Omitted fields keep their values, including a custom timeout. Set `scriptTimeoutMs` to `null` to remove the override and use the default timeout. Metadata updates preserve all source bytes.

You can repair an invalid cron expression and resume in one update by supplying both `trigger` and `enabled: true`. Pico validates the resulting metadata and still rejects enabling a schedule with invalid source files.

Set `enabled` to `false` to pause or `true` to resume. This moves the directory between `disabled/<id>` and `enabled/<id>`. Call `schedule_get` again after a state change before editing files, rather than reusing the old path.

Changing `name`, `target`, `trigger`, or `scriptTimeoutMs` creates a new metadata revision. Changing only `enabled` preserves the revision.

## Write script.js

Write a Bun JavaScript program. Pico runs a snapshot with the target chat's working directory as `process.cwd()`. Relative data paths use that directory, but relative imports use the script snapshot's directory.

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

Save this script as `script.js`. In `prompt.md`, write `Review the working-tree status above and inspect relevant diffs. Summarize risks without modifying files.` The script checks the current state on each run, not changes since the previous run.

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
