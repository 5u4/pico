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

