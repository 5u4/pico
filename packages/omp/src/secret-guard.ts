import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type {
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { resolveArtifactFile } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { validateRelativePath } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { parseXdUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";
import {
  expandDelimitedPathEntries,
  expandPath,
  findUniqueWorkspaceSuffix,
  hasGlobPathChars,
  isReadableUrlPath,
  normalizeLocalScheme,
  normalizePathLikeInput,
  parseFindPattern,
  parseSearchPathPreferringLiteral,
  peelWriteUrlSelector,
  probeLiteralPathExists,
  resolveReadPath,
  resolveToCwd,
  resolveToolSearchScope,
  splitInternalUrlSel,
  splitPathAndSelPreferringLiteral,
  toPathList,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { splitPdfImageReadPath } from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import { parseSqlitePathCandidates } from "@oh-my-pi/pi-coding-agent/tools/sqlite-reader";
import { splitVideoReadTarget } from "@oh-my-pi/pi-coding-agent/utils/video";
import { editInspect } from "@oh-my-pi/pi-natives";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";
import type { PicoPaths } from "@pico/contract/config";

interface Policy {
  readonly secrets: readonly string[];
  readonly managed: readonly string[];
  readonly files: readonly string[];
}

type Access = "read" | "search" | "write";
type GuardContext = Pick<ExtensionContext, "cwd" | "localProtocolOptions" | "sessionManager">;
type ProtectedPaths = Pick<
  PicoPaths,
  "root" | "secretsDir" | "sessionsDir" | "schedulesDir" | "logsDir" | "configFile" | "storeFile"
>;

const blocked = {
  block: true,
  reason: "Pico protects this path. Use project files or the schedule tools.",
};
const unresolved = {
  block: true,
  reason: "Pico could not establish a safe file target. Use an explicit project path.",
};

export const make =
  (paths: ProtectedPaths): ExtensionFactory =>
  async (api) => {
    const secrets = [paths.secretsDir];
    const managed = [paths.sessionsDir, paths.schedulesDir, paths.logsDir];
    const files = [
      paths.configFile,
      paths.storeFile,
      `${paths.storeFile}-wal`,
      `${paths.storeFile}-shm`,
      `${paths.storeFile}-journal`,
      join(paths.root, ".pico.lock"),
    ];
    const policy: Policy = {
      secrets: [...secrets, ...(await Promise.all(secrets.map(canonicalPath)))],
      managed: [...managed, ...(await Promise.all(managed.map(canonicalPath)))],
      files: [...files, ...(await Promise.all(files.map(canonicalPath)))],
    };

    api.on("tool_call", async (event, ctx) => {
      try {
        return (await checkTool(event, ctx, policy)) ? blocked : undefined;
      } catch {
        return unresolved;
      }
    });
  };

const within = (target: string, root: string): boolean => {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
};

const canonicalPath = async (target: string): Promise<string> => {
  try {
    return await realpath(target);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Unresolved symbolic link");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const parent = dirname(target);
  if (parent === target) throw new Error("Unresolved filesystem root");
  return join(await canonicalPath(parent), basename(target));
};

const denies = async (target: string, access: Access, policy: Policy): Promise<boolean> => {
  const canonical = await canonicalPath(target);
  for (const candidate of [target, canonical]) {
    if (
      policy.secrets.some(
        (root) => within(candidate, root) || (access !== "read" && within(root, candidate)),
      )
    ) {
      return true;
    }
    if (
      access === "write" &&
      (policy.managed.some((root) => within(candidate, root) || within(root, candidate)) ||
        policy.files.some((file) => within(file, candidate)))
    ) {
      return true;
    }
  }
  return false;
};

const localTarget = async (
  raw: string,
  access: Access,
  ctx: GuardContext,
): Promise<string | undefined> => {
  const normalized = normalizeLocalScheme(expandPath(raw));
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(normalized);
  if (!match)
    return access === "write" ? resolveToCwd(raw, ctx.cwd) : resolveReadPath(raw, ctx.cwd);
  const target =
    access === "write" ? peelWriteUrlSelector(normalized) : splitInternalUrlSel(normalized).path;
  switch (match[1]?.toLowerCase()) {
    case "local":
      if (!ctx.localProtocolOptions) throw new Error("Missing session local mapping");
      return resolveLocalUrlToPath(target, ctx.localProtocolOptions);
    case "artifact":
      if (access === "write") throw new Error("Artifact is read-only");
      return (await resolveArtifactFile(parseInternalUrl(target), ctx)).path;
    case "skill": {
      const url = parseInternalUrl(target);
      const skill = getActiveSkills().find((skill) => skill.name === (url.rawHost || url.hostname));
      if (!skill) throw new Error("Unknown skill");
      if (!url.pathname || url.pathname === "/")
        return access === "read" ? skill.filePath : skill.baseDir;
      const child = decodeURIComponent(url.pathname.slice(1));
      validateRelativePath(child);
      return join(skill.baseDir, child);
    }
    case "rule": {
      const url = parseInternalUrl(target);
      const rule = getActiveRules().find((rule) => rule.name === (url.rawHost || url.hostname));
      if (!rule) throw new Error("Unknown rule");
      return rule.path;
    }
    case "conflict":
      if (access === "write") throw new Error("Missing conflict mutation target");
      return undefined;
    default:
      return undefined;
  }
};

const checkPath = async (
  raw: string,
  access: Access,
  ctx: GuardContext,
  policy: Policy,
): Promise<boolean> => {
  let path =
    access === "write"
      ? unwrapHashlineHeaderPath(raw)
      : raw.startsWith("file://")
        ? expandPath(raw)
        : raw;
  // Device dispatch emits another tool_call under the mounted tool's own name.
  if (
    access !== "search" &&
    parseXdUrl(access === "write" ? peelWriteUrlSelector(path) : splitInternalUrlSel(path).path)
  )
    return false;
  if (
    access === "read" &&
    (!path.includes("://") || path.startsWith("local://")) &&
    parseSqlitePathCandidates(path).length === 0
  ) {
    const query = path.indexOf("?");
    if (query >= 0 && new URLSearchParams(path.slice(query + 1)).get("q"))
      path = path.slice(0, query);
  }
  if (
    access !== "write" &&
    isReadableUrlPath(path) &&
    (access === "read" ||
      /^https?:\/\//i.test(path) ||
      (!hasGlobPathChars(path) && (await probeLiteralPathExists(path, ctx.cwd)) === "missing"))
  )
    return false;
  const normalized = normalizeLocalScheme(expandPath(path));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    const target = await localTarget(path, access, ctx);
    return target === undefined ? false : denies(target, access, policy);
  }

  const candidates = new Set<string>();
  for (const candidate of parseArchivePathCandidates(path)) candidates.add(candidate.archivePath);
  for (const candidate of parseSqlitePathCandidates(path)) candidates.add(candidate.sqlitePath);
  if (access !== "write" && candidates.size === 0) {
    const pdf = splitPdfImageReadPath(path);
    const video = splitVideoReadTarget(path);
    candidates.add(
      pdf?.pdfPath ?? video?.path ?? (await splitPathAndSelPreferringLiteral(path, ctx.cwd)).path,
    );
  } else if (access === "write") {
    candidates.add(path);
  }

  for (const candidate of candidates) {
    const target =
      access === "search"
        ? (await parseSearchPathPreferringLiteral(candidate, ctx.cwd)).basePath
        : candidate;
    const absolute = await localTarget(target, access, ctx);
    if (absolute === undefined) continue;
    if (await denies(absolute, access, policy)) return true;
    if (access === "read" && (await probeLiteralPathExists(target, ctx.cwd)) === "missing") {
      if (await denies(ctx.cwd, "search", policy)) return true;
      const suffix = await findUniqueWorkspaceSuffix(target, ctx.cwd);
      if (suffix && (await denies(suffix.absolutePath, "read", policy))) return true;
      // OMP can recover missing reads through session-only plan aliases after suffix lookup.
      if (!suffix) throw new Error("Missing explicit read target");
    }
  }
  return false;
};

const hashlineSources = (input: string): string[] => {
  const lines = input.replace(/^\uFEFF/, "").split("\n");
  const first = lines.find((line) => line.trim() !== "" && line.trimEnd() !== "*** Begin Patch");
  if (!first?.startsWith("[")) return [];
  const paths: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("[")) continue;
    const match = /^\[([^#\r\n]+)#[0-9a-fA-F]{4}\]$/.exec(line.trimEnd());
    const path = match?.[1];
    // pi-edit 18.1.17 inspection omits execution's header recovery. Accept only unchanged paths.
    if (
      !path ||
      path !== path.trim() ||
      /^["']/.test(path) ||
      path.replace(
        /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i,
        "",
      ) !== path
    ) {
      throw new Error("Use canonical hashline headers");
    }
    paths.push(path);
  }
  return paths;
};

const checkTool = async (
  event: ToolCallEvent,
  ctx: GuardContext,
  policy: Policy,
): Promise<boolean> => {
  const input = event.input;
  switch (event.toolName) {
    case "read":
    case "grep":
    case "glob": {
      const raw = "path" in input ? input.path : undefined;
      if (
        raw !== undefined &&
        raw !== null &&
        typeof raw !== "string" &&
        !(Array.isArray(raw) && raw.every((part): part is string => typeof part === "string"))
      ) {
        throw new Error("Invalid file targets");
      }
      const entries = toPathList(raw ?? undefined);
      if (event.toolName === "read" && entries.length === 0) throw new Error("Missing read target");
      const targets = await expandDelimitedPathEntries(
        entries.length > 0 ? entries : ["."],
        ctx.cwd,
        event.toolName === "glob" ? { splitter: parseFindPattern } : undefined,
      );
      for (const target of targets) {
        const path = normalizePathLikeInput(target);
        if (event.toolName === "glob") {
          const normalized = normalizeLocalScheme(expandPath(path));
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
            if (await checkPath(path, "search", ctx, policy)) return true;
          } else if (
            await denies(resolveToCwd(parseFindPattern(path).basePath, ctx.cwd), "search", policy)
          ) {
            return true;
          }
        } else if (
          await checkPath(path, event.toolName === "read" ? "read" : "search", ctx, policy)
        ) {
          return true;
        }
      }
      return false;
    }
    case "ast_grep":
    case "ast_edit": {
      const rewriting = event.toolName === "ast_edit";
      const raw = rewriting
        ? "paths" in input
          ? input.paths
          : undefined
        : "path" in input
          ? input.path
          : undefined;
      if (
        raw !== undefined &&
        raw !== null &&
        typeof raw !== "string" &&
        !(Array.isArray(raw) && raw.every((part): part is string => typeof part === "string"))
      ) {
        throw new Error("Invalid AST targets");
      }
      const entries = toPathList(raw ?? undefined);
      if (rewriting && entries.length === 0) throw new Error("Missing AST rewrite targets");
      const rawPaths = await expandDelimitedPathEntries(
        (entries.length > 0 ? entries : ["."]).map(normalizePathLikeInput),
        ctx.cwd,
      );
      // OMP's skill URL handler reads file content even during path-only scope resolution.
      for (const path of rawPaths) {
        if (path.includes("://") && (await checkPath(path, "search", ctx, policy))) return true;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      const scope = await resolveToolSearchScope({
        rawPaths,
        cwd: ctx.cwd,
        internalUrlAction: rewriting ? "rewrite" : "search",
        ...(sessionFile ? { sessionFile } : {}),
        sessionId: ctx.sessionManager.getSessionId(),
        ...(ctx.localProtocolOptions ? { localProtocolOptions: ctx.localProtocolOptions } : {}),
        skills: getActiveSkills(),
        rules: getActiveRules(),
      });
      const access = rewriting ? "write" : "search";
      for (const target of scope.multiTargets ?? [{ basePath: scope.searchPath }]) {
        if (await denies(target.basePath, access, policy)) return true;
      }
      return false;
    }
    case "write":
      if (!("path" in input) || typeof input.path !== "string")
        throw new Error("Missing write target");
      return checkPath(input.path, "write", ctx, policy);
    case "edit": {
      const targets = new Set<string>();
      const sources = new Set<string>();
      const text = "input" in input ? input.input : "_input" in input ? input._input : undefined;
      const firstOperations = new Map<string, "create" | "source">();
      if (typeof text === "string") {
        for (const path of hashlineSources(text)) {
          targets.add(path);
          sources.add(path);
        }
        for (const line of text.split("\n")) {
          const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trimEnd());
          if (match?.[2] && !firstOperations.has(match[2])) {
            firstOperations.set(match[2], match[1] === "Add" ? "create" : "source");
          }
        }
      }
      const edits: readonly unknown[] =
        "edits" in input && Array.isArray(input.edits) ? input.edits : [];
      const firstEdit = edits.find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      );
      const createsPath =
        firstEdit?.op === "create" &&
        (typeof firstEdit.old_string !== "string" || firstEdit.old_string === "");
      const args = JSON.stringify(input);
      // Tool events omit the active edit mode. Inspect every supported grammar, not just compatibility paths.
      for (const mode of ["hashline", "patch", "replace", "apply_patch", "sloppy"]) {
        let inspection: ReturnType<typeof editInspect>;
        try {
          inspection = editInspect(mode, args);
        } catch {
          continue;
        }
        for (const path of inspection.paths) {
          targets.add(path);
          if (
            !(mode === "apply_patch" && firstOperations.get(path) === "create") &&
            !((mode === "patch" || mode === "replace") && createsPath)
          )
            sources.add(path);
        }
        for (const operation of inspection.fileOps) {
          targets.add(operation.path);
          if (
            !(mode === "apply_patch" && firstOperations.get(operation.path) === "create") &&
            !(mode === "patch" && createsPath)
          ) {
            sources.add(operation.path);
          }
          if (operation.to) targets.add(operation.to);
        }
      }
      if ("path" in input && typeof input.path === "string") {
        targets.add(input.path);
        if (!createsPath) sources.add(input.path);
      }
      if ("paths" in input && Array.isArray(input.paths)) {
        for (const path of input.paths) {
          if (typeof path !== "string") throw new Error("Invalid edit target");
          targets.add(path);
        }
      }
      if (targets.size === 0) throw new Error("Missing edit targets");
      for (const target of targets) {
        if (await checkPath(target, "write", ctx, policy)) return true;
      }
      for (const source of sources) {
        const path = unwrapHashlineHeaderPath(source);
        const absolute = await localTarget(path, "write", ctx);
        if (absolute === undefined) continue;
        try {
          await lstat(absolute);
          continue;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        if (await denies(ctx.cwd, "search", policy)) return true;
        const suffix = await findUniqueWorkspaceSuffix(path, ctx.cwd);
        if (!suffix) throw new Error("Missing explicit edit source");
        if (await checkPath(suffix.absolutePath, "write", ctx, policy)) return true;
      }
      return false;
    }
    default:
      return false;
  }
};
