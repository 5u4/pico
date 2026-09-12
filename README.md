<div align="center">
<h1>pico</h1>
</div>

## Install

Install [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh/docs/installation) 1.3.14 or newer.

In a macOS or Linux terminal:

```sh
git clone https://github.com/5u4/pico.git
cd pico
bun install
bun link --cwd packages/cli
export PATH="$(bun pm bin -g):$PATH"
pico start
```

Add the `export PATH` line to your shell configuration so new terminals can find `pico`.
Keep Bun's bin directory before `/usr/bin`, which contains a text editor also named `pico` on macOS.

The daemon runs in the foreground and creates its data directory at `~/.pico`.
Wait for `pico.daemon.ready`. Press Ctrl-C to stop; press it again only if cleanup is stuck.
To use another data directory, run `pico start /absolute/path/to/root`.

Keep the cloned repository and its installed dependencies: `pico` links to the source rather than
copying it. Source changes take effect on the next start. If you move the repository, run
`bun link --cwd packages/cli` again from its new location.

Run `pico start` directly, not through `bun run`, to avoid duplicate SIGINT delivery.

## Discord steering

Messages sent in an active chat's Discord thread enter OMP as steers without waiting for the
current run to finish. Each accepted steer gets a ⏳ reaction on its original message. When OMP
adds that message to its context, pico replaces ⏳ with ✅. Consumption does not mean the task
has finished.

Each message has its own receipt, including messages with identical text or images. Removing a
queued steer clears ⏳ without adding ✅. Receipts are in memory and are not replayed after a
restart. The bot needs permission to add reactions in the thread.

## OMP delivery notifications

The pinned OMP dependency has a Bun patch because its SDK does not expose per-message admission
and consumption notifications. The patch attaches observers to native messages and uses OMP's
context-insertion callbacks. Pico does not match message text or maintain another execution queue.

`bun install` applies the patch. When upgrading OMP, rebase or remove the patch and run
`bun --bun x vitest run packages/omp/src/omp-delivery.test.ts packages/omp/src/session-pool-native.test.ts`
to check delivery timing, queue removal, and continuation ownership against the new SDK.
