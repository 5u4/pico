import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { getActiveRules, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getActiveSkills, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { normalizeToolEventInput } from "@oh-my-pi/pi-coding-agent/extensibility/tool-event-input";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type PicoPaths, PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import { make } from "./secret-guard.ts";

const fixture = async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pico-path-guard-")));
  const root = PicoRoot.make(join(temporary, "pico"));
  const child = (name: string) => AbsolutePath.make(join(root, name));
  const paths: PicoPaths = {
    root,
    configFile: child("config.toml"),
    storeFile: child("store.db"),
    secretsDir: child("secrets"),
    sessionsDir: child("sessions"),
    schedulesDir: child("schedules"),
    logsDir: child("logs"),
    worktreesDir: child("worktrees"),
  };
  const cwd = join(paths.worktreesDir, "chat");
  const artifactsDir = join(temporary, "artifacts");
  try {
    await Promise.all(
      [
        cwd,
        paths.secretsDir,
        paths.sessionsDir,
        paths.schedulesDir,
        paths.logsDir,
        join(artifactsDir, "local"),
      ].map((path) => mkdir(path, { recursive: true })),
    );
    await Promise.all(
      [
        join(paths.secretsDir, "token.txt"),
        join(paths.secretsDir, "bundle.zip"),
        join(paths.secretsDir, "private.db"),
        paths.configFile,
        paths.storeFile,
        join(cwd, "ordinary.ts"),
        join(artifactsDir, "local", "scratch.txt"),
      ].map((path) => writeFile(path, "fabricated fixture\n")),
    );
    const extension = await loadExtensionFromFactory(
      make(paths),
      cwd,
      new EventBus(),
      new ExtensionRuntime(),
    );
    const handler = extension.handlers.get("tool_call")?.[0];
    if (!handler) throw new Error("Path guard did not register its tool-call handler");
    const sessionManager = SessionManager.inMemory(cwd);
    const call = async (
      toolName: ToolCallEvent["toolName"],
      input: Record<string, unknown>,
      workingDirectory = cwd,
    ) => {
      const event: ToolCallEvent = {
        type: "tool_call",
        toolCallId: "guard-regression",
        toolName,
        input: normalizeToolEventInput(toolName, input),
      };
      const context = {
        cwd: workingDirectory,
        sessionManager,
        localProtocolOptions: { getArtifactsDir: () => artifactsDir },
      } satisfies Pick<ExtensionContext, "cwd" | "localProtocolOptions" | "sessionManager">;
      const result = await handler(event, context);
      return (
        typeof result === "object" && result !== null && "block" in result && result.block === true
      );
    };
    return {
      paths,
      cwd,
      artifactsDir,
      call,
      close: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
};

const patch = (...sections: string[]) => `*** Begin Patch\n${sections.join("\n")}\n*** End Patch`;

describe("Pico path guard", () => {
  it("checks selectors and containers against their backing secret file", async () => {
    const f = await fixture();
    try {
      const secret = relative(f.cwd, join(f.paths.secretsDir, "token.txt"));
      assert.isTrue(await f.call("read", { path: `${secret}:1-2:raw` }));
      assert.isTrue(
        await f.call("read", { path: `${f.paths.secretsDir}/bundle.zip:inside.txt:raw` }),
      );
      assert.isTrue(
        await f.call("read", { path: `${f.paths.secretsDir}/private.db:tokens?limit=1` }),
      );
      assert.isTrue(
        await f.call("write", {
          path: `${f.paths.secretsDir}/bundle.zip:inside.txt`,
          content: "changed",
        }),
      );
      assert.isFalse(await f.call("read", { path: "ordinary.ts:raw" }));
    } finally {
      await f.close();
    }
  });

  it("resolves encoded file URLs and session-local aliases without reading their bytes", async () => {
    const f = await fixture();
    try {
      const encoded = join(f.cwd, "secret:alias.txt");
      await symlink(join(f.paths.secretsDir, "token.txt"), encoded);
      await symlink(f.paths.secretsDir, join(f.artifactsDir, "local", "private"));
      assert.isTrue(await f.call("read", { path: `${pathToFileURL(encoded).href}:raw` }));
      assert.isTrue(await f.call("read", { path: "local://private/token.txt:raw" }));
      assert.isTrue(await f.call("write", { path: "local://private/new.txt", content: "changed" }));
      assert.isFalse(await f.call("read", { path: "local://scratch.txt" }));
      assert.isFalse(
        await f.call("write", { path: "local://new.txt", content: "project scratch" }),
      );
      assert.isTrue(await f.call("write", { path: "conflict://1", content: "changed" }));
      assert.isTrue(await f.call("read", { path: "skill://unresolvable-local-alias/file.txt" }));
      await symlink(
        join(f.paths.secretsDir, "token.txt"),
        join(f.artifactsDir, "local", "image.svg"),
      );
      assert.isTrue(await f.call("read", { path: "local://image.svg:img?q=describe" }));
    } finally {
      await f.close();
    }
  });

  it("resolves skill and rule metadata while checking their canonical backing paths", async () => {
    const f = await fixture();
    const previousSkills = getActiveSkills();
    const previousRules = getActiveRules();
    try {
      const instructions = join(f.cwd, "instructions");
      await mkdir(instructions);
      await writeFile(join(instructions, "SKILL.md"), "fabricated instructions");
      await writeFile(join(instructions, "guide page.txt"), "fabricated guide");
      await symlink(f.paths.secretsDir, join(instructions, "private"));
      setActiveSkills([
        {
          name: "fixture:help",
          description: "fixture",
          source: "fixture",
          baseDir: instructions,
          filePath: join(instructions, "SKILL.md"),
        },
        {
          name: "fixture:private",
          description: "fixture",
          source: "fixture",
          baseDir: join(instructions, "private"),
          filePath: join(instructions, "private", "token.txt"),
        },
      ]);
      setActiveRules([
        {
          name: "fixture-help",
          path: join(instructions, "SKILL.md"),
          get content(): string {
            throw new Error("The guard must not read rule content");
          },
          _source: {
            provider: "fixture",
            providerName: "fixture",
            path: instructions,
            level: "project",
          },
        },
        {
          name: "fixture-private",
          path: join(instructions, "private", "token.txt"),
          get content(): string {
            throw new Error("The guard must not read rule content");
          },
          _source: {
            provider: "fixture",
            providerName: "fixture",
            path: instructions,
            level: "project",
          },
        },
      ]);
      assert.isFalse(await f.call("read", { path: "skill://fixture:help:raw" }));
      assert.isFalse(await f.call("read", { path: "skill://fixture:help/guide%20page.txt:raw" }));
      assert.isFalse(
        await f.call("grep", { pattern: "fabricated", path: "skill://fixture:help/SKILL.md" }),
      );
      assert.isFalse(await f.call("read", { path: "rule://fixture-help:raw" }));
      assert.isTrue(await f.call("read", { path: "skill://fixture:private" }));
      assert.isTrue(await f.call("grep", { pattern: "fixture", path: "skill://fixture:private" }));
      assert.isTrue(await f.call("read", { path: "skill://fixture:help/private/token.txt" }));
      assert.isTrue(await f.call("read", { path: "rule://fixture-private" }));
      assert.isTrue(await f.call("read", { path: "rule://fixture-missing" }));
    } finally {
      setActiveSkills(previousSkills);
      setActiveRules(previousRules);
      await f.close();
    }
  });

  it("leaves other protocol operations to OMP rather than treating the guard as a sandbox", async () => {
    const f = await fixture();
    try {
      for (const path of [
        "agent://fixture",
        "history://fixture",
        "omp://",
        "mcp://fixture",
        "ssh://fixture/path",
        "unknown://fixture",
      ]) {
        assert.isFalse(await f.call("read", { path }), path);
      }
      assert.isFalse(await f.call("write", { path: "ssh://fixture/path", content: "fabricated" }));
      assert.isFalse(await f.call("write", { path: "unknown://fixture", content: "fabricated" }));
    } finally {
      await f.close();
    }
  });

  it("follows existing symlinks and the nearest existing ancestor of new files", async () => {
    const f = await fixture();
    try {
      await symlink(f.paths.secretsDir, join(f.cwd, "private-link"));
      await symlink(f.paths.logsDir, join(f.cwd, "logs-link"));
      await symlink(f.cwd, join(f.cwd, "project-link"));
      await symlink(join(f.paths.secretsDir, "not-created"), join(f.cwd, "dangling-link"));
      assert.isTrue(await f.call("read", { path: "private-link/token.txt" }));
      assert.isTrue(
        await f.call("write", { path: "private-link/new/nested/token.txt", content: "changed" }),
      );
      assert.isTrue(
        await f.call("write", { path: "logs-link/new/nested/log.txt", content: "changed" }),
      );
      assert.isTrue(await f.call("write", { path: "dangling-link", content: "changed" }));
      assert.isFalse(
        await f.call("write", { path: "project-link/new/nested/code.ts", content: "export {}" }),
      );
    } finally {
      await f.close();
    }
  });

  it("rejects ancestor and default search scopes but not similarly named project paths", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.cwd, "secrets"));
      await writeFile(join(f.cwd, "secrets", "example.txt"), "public example");
      await mkdir(`${f.paths.secretsDir}-examples`);
      await writeFile(`${f.paths.secretsDir}-examples/public.txt`, "public example");
      assert.isTrue(await f.call("grep", { pattern: "fixture" }, f.paths.root));
      assert.isTrue(await f.call("grep", { pattern: "fixture", path: "../.." }));
      assert.isTrue(await f.call("glob", { path: `${f.paths.root}/**/*.txt` }));
      assert.isFalse(await f.call("grep", { pattern: "example", path: "secrets" }));
      assert.isFalse(await f.call("read", { path: `${f.paths.secretsDir}-examples/public.txt` }));
      assert.isFalse(await f.call("glob", { path: "**/*.ts" }));
      assert.isFalse(await f.call("write", { path: "secrets/new.ts", content: "export {}" }));
    } finally {
      await f.close();
    }
  });

  it("checks every search and read root rather than trusting the first", async () => {
    const f = await fixture();
    try {
      const secret = join(f.paths.secretsDir, "token.txt");
      assert.isTrue(await f.call("grep", { pattern: "fixture", path: `ordinary.ts;${secret}:1` }));
      assert.isTrue(
        await f.call("grep", { pattern: "fixture", path: JSON.stringify(["ordinary.ts", secret]) }),
      );
      assert.isTrue(await f.call("glob", { path: ["*.ts", `${f.paths.secretsDir}/*.txt`] }));
      assert.isTrue(await f.call("read", { path: `ordinary.ts;${secret}` }));
      assert.isFalse(await f.call("grep", { pattern: "fixture", path: "ordinary.ts:1" }));
    } finally {
      await f.close();
    }
  });

  it("honors grep's local precedence for URL-shaped symlinks", async () => {
    const f = await fixture();
    try {
      await symlink(join(f.paths.secretsDir, "token.txt"), join(f.cwd, "www.token"));
      await symlink(join(f.cwd, "ordinary.ts"), join(f.cwd, "www.project"));
      assert.isTrue(await f.call("grep", { pattern: "fixture", path: "www.token" }));
      assert.isFalse(await f.call("grep", { pattern: "fixture", path: "www.project" }));
      assert.isFalse(await f.call("grep", { pattern: "fixture", path: "www.example.invalid" }));
      assert.isFalse(await f.call("read", { path: "www.token" }));
    } finally {
      await f.close();
    }
  });

  it("blocks AST secret searches and managed rewrites before a preview can be staged", async () => {
    const f = await fixture();
    try {
      const secret = join(f.paths.secretsDir, "token.ts");
      const managed = join(f.paths.schedulesDir, "script.js");
      await writeFile(secret, 'const token = "fabricated";\n');
      await writeFile(managed, "oldApi();\n");
      const ops = [{ pat: "oldApi()", out: "newApi()" }];
      assert.isTrue(await f.call("ast_grep", { pat: "token", path: secret }));
      assert.isTrue(await f.call("ast_edit", { ops, paths: [secret] }));
      assert.isTrue(await f.call("ast_edit", { ops, paths: [managed] }));
      assert.isFalse(await f.call("ast_grep", { pat: "oldApi()", path: managed }));
      assert.isFalse(await f.call("ast_grep", { pat: "token", path: "ordinary.ts" }));
      assert.isFalse(await f.call("ast_edit", { ops, paths: ["ordinary.ts"] }));
    } finally {
      await f.close();
    }
  });

  it("authorizes the resolved AST roots for default, delimited, and glob scopes", async () => {
    const f = await fixture();
    try {
      const secret = join(f.paths.secretsDir, "token.txt");
      const ops = [{ pat: "oldApi()", out: "newApi()" }];
      assert.isTrue(await f.call("ast_grep", { pat: "token" }, f.paths.root));
      assert.isTrue(await f.call("ast_grep", { pat: "token", path: `ordinary.ts;${secret}` }));
      assert.isTrue(await f.call("ast_grep", { pat: "token", path: `${f.paths.root}/**/*.ts` }));
      assert.isTrue(await f.call("ast_edit", { ops, paths: [f.paths.root] }));
      assert.isTrue(await f.call("ast_edit", { ops, paths: [`${f.paths.root}/**/*.ts`] }));
      assert.isTrue(
        await f.call("ast_edit", { ops, paths: ["ordinary.ts", f.paths.schedulesDir] }),
      );
      assert.isTrue(
        await f.call("ast_edit", { ops, paths: [`ordinary.ts;${f.paths.schedulesDir}`] }),
      );
      assert.isFalse(await f.call("ast_grep", { pat: "token" }));
      assert.isFalse(await f.call("ast_grep", { pat: "token", path: "**/*.ts" }));
      assert.isFalse(await f.call("ast_edit", { ops, paths: ["**/*.ts"] }));
    } finally {
      await f.close();
    }
  });

  it("resolves AST filesystem aliases and local URLs before applying the path policy", async () => {
    const f = await fixture();
    try {
      const ops = [{ pat: "oldApi()", out: "newApi()" }];
      await symlink(f.paths.secretsDir, join(f.cwd, "private-link"));
      await symlink(f.paths.schedulesDir, join(f.artifactsDir, "local", "managed"));
      await symlink(f.paths.secretsDir, join(f.artifactsDir, "local", "private"));
      assert.isTrue(await f.call("ast_grep", { pat: "token", path: "private-link/*" }));
      assert.isTrue(await f.call("ast_grep", { pat: "token", path: "local://private/token.txt" }));
      assert.isTrue(await f.call("ast_edit", { ops, paths: ["local://managed"] }));
      assert.isTrue(
        await f.call("ast_edit", { ops, paths: [pathToFileURL(f.paths.secretsDir).href] }),
      );
      assert.isFalse(await f.call("ast_grep", { pat: "token", path: "local://scratch.txt" }));
      assert.isFalse(await f.call("ast_edit", { ops, paths: ["local://scratch.txt"] }));
    } finally {
      await f.close();
    }
  });

  it("blocks managed files, database row writes, and every SQLite sidecar", async () => {
    const f = await fixture();
    try {
      const targets = [
        f.paths.configFile,
        f.paths.storeFile,
        `${f.paths.storeFile}:chats:1`,
        `${f.paths.storeFile}-wal`,
        `${f.paths.storeFile}-shm`,
        `${f.paths.storeFile}-journal`,
        join(f.paths.root, ".pico.lock"),
        join(f.paths.sessionsDir, "new.jsonl"),
        join(f.paths.schedulesDir, "enabled", "id.json"),
        join(f.paths.logsDir, "new.log"),
      ];
      for (const path of targets)
        assert.isTrue(await f.call("write", { path, content: "changed" }), path);
      assert.isTrue(
        await f.call("write", { path: `[${f.paths.configFile}#ABCD]`, content: "changed" }),
      );
      assert.isFalse(await f.call("read", { path: f.paths.configFile }));
      assert.isFalse(await f.call("write", { path: "ordinary.ts", content: "export {}" }));
    } finally {
      await f.close();
    }
  });

  it("inspects all hashline sections even when a compatibility path claims a safe target", async () => {
    const f = await fixture();
    try {
      const input = patch(
        "[ordinary.ts#ABCD]\nPUT 1.=1:\n+safe change",
        `[${f.paths.configFile}#ABCD]\nPUT 1.=1:\n+managed change`,
      );
      assert.isTrue(await f.call("edit", { input }));
      assert.isTrue(await f.call("edit", { input, path: "ordinary.ts" }));
      assert.isFalse(
        await f.call("edit", { input: patch("[ordinary.ts#ABCD]\nPUT 1.=1:\n+safe change") }),
      );
    } finally {
      await f.close();
    }
  });

  it("rejects recovered hashline headings even for unanchored EOF appends", async () => {
    const f = await fixture();
    try {
      const append = (header: string) => patch(`${header}\nPUT >$:\n+changed`);
      assert.isTrue(
        await f.call("edit", {
          input: append(`[Update File: ${f.paths.configFile}#ABCD]`),
          path: "ordinary.ts",
        }),
      );
      assert.isTrue(
        await f.call("edit", {
          _input: append(`["${join(f.paths.secretsDir, "token.txt")}"#ABCD]`),
        }),
      );
      assert.isTrue(
        await f.call("edit", {
          input: append(`[*** Begin Patch] [${f.paths.configFile}#ABCD]`),
        }),
      );
      assert.isFalse(await f.call("edit", { input: append("[ordinary.ts#ABCD]") }));
      await mkdir(join(f.cwd, "app", "[slug]"), { recursive: true });
      await writeFile(join(f.cwd, "app", "[slug]", "page.ts"), "fabricated");
      assert.isFalse(await f.call("edit", { input: append("[app/[slug]/page.ts#ABCD]") }));
    } finally {
      await f.close();
    }
  });

  it("checks both move endpoints across hashline and patch edit modes", async () => {
    const f = await fixture();
    try {
      assert.isTrue(
        await f.call("edit", { input: patch(`[ordinary.ts#ABCD]\nMV ${f.paths.configFile}`) }),
      );
      assert.isTrue(
        await f.call("edit", { input: patch(`[${f.paths.configFile}#ABCD]\nMV ordinary.ts`) }),
      );
      assert.isTrue(
        await f.call("edit", {
          path: "ordinary.ts",
          edits: [{ op: "update", rename: f.paths.configFile, diff: "@@\n-old\n+new" }],
        }),
      );
      assert.isTrue(
        await f.call("edit", {
          input: `*** Begin Patch\n*** Update File: ordinary.ts\n*** Move to: ${f.paths.configFile}\n@@\n-old\n+new\n*** End Patch`,
        }),
      );
      assert.isFalse(await f.call("edit", { input: patch("[ordinary.ts#ABCD]\nMV renamed.ts") }));
      assert.isFalse(
        await f.call("edit", { path: "ordinary.ts", old_string: "fixture", new_string: "project" }),
      );
    } finally {
      await f.close();
    }
  });

  it("checks missing edit source recovery without recovering creation or move destinations", async () => {
    const f = await fixture();
    try {
      assert.isTrue(
        await f.call(
          "edit",
          {
            path: "token.txt",
            old_string: "fabricated",
            new_string: "changed",
          },
          f.paths.root,
        ),
      );
      assert.isTrue(
        await f.call(
          "edit",
          {
            input: patch("[token.txt#ABCD]\nPUT >$:\n+changed"),
          },
          f.paths.root,
        ),
      );
      await mkdir(join(f.cwd, "nested"));
      await symlink(f.paths.configFile, join(f.cwd, "nested", "managed.toml"));
      await writeFile(join(f.cwd, "nested", "source.ts"), "fabricated");
      assert.isTrue(
        await f.call("edit", {
          path: "managed.toml",
          old_string: "fabricated",
          new_string: "changed",
        }),
      );
      assert.isFalse(
        await f.call("edit", {
          path: "source.ts",
          old_string: "fabricated",
          new_string: "changed",
        }),
      );
      assert.isFalse(
        await f.call(
          "edit",
          {
            path: "token.txt",
            edits: [{ op: "create", diff: "public project file" }],
          },
          f.paths.root,
        ),
      );
      assert.isFalse(
        await f.call(
          "edit",
          {
            input: patch("*** Add File: token.txt\n+public project file"),
          },
          f.paths.root,
        ),
      );
      assert.isFalse(
        await f.call(
          "edit",
          {
            input: patch(
              `[${join(f.cwd, "ordinary.ts")}#ABCD]\nMV ${join(f.paths.root, "token.txt")}`,
            ),
          },
          f.paths.root,
        ),
      );
      assert.isTrue(
        await f.call(
          "edit",
          {
            path: "token.txt",
            edits: [{ op: "create", old_string: "fabricated", new_string: "changed" }],
          },
          f.paths.root,
        ),
      );
    } finally {
      await f.close();
    }
  });

  it("allows schedule device transport without exempting mounted filesystem calls", async () => {
    const f = await fixture();
    try {
      for (const toolName of [
        "schedule_create",
        "schedule_list",
        "schedule_get",
        "schedule_update",
        "schedule_set_enabled",
        "schedule_delete",
      ]) {
        assert.isFalse(
          await f.call(toolName, {
            path: f.paths.schedulesDir,
            script: `read(${JSON.stringify(f.paths.secretsDir)})`,
          }),
        );
        assert.isFalse(
          await f.call("write", {
            path: `xd://${toolName}`,
            content: JSON.stringify({
              path: f.paths.schedulesDir,
              script: `read(${JSON.stringify(f.paths.secretsDir)})`,
            }),
          }),
        );
      }
      assert.isFalse(await f.call("read", { path: "xd://schedule_create" }));
      assert.isFalse(await f.call("read", { path: "xd://" }));
      const protectedWrite = { path: f.paths.configFile, content: "changed" };
      assert.isFalse(
        await f.call("write", { path: "xd://write", content: JSON.stringify(protectedWrite) }),
      );
      assert.isTrue(await f.call("write", protectedWrite));
    } finally {
      await f.close();
    }
  });
});
