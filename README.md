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
