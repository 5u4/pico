import {
	createAgentSession,
	discoverAuthStorage,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	Settings,
	type AgentSession,
	type AgentSessionEvent,
	type AuthStorage,
	type ExtensionFactory,
	type Model,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { makeCamofoxFactory } from "./extensions/camofox";
import { makeScheduleFactory } from "./extensions/schedule";
import { makeSecretGuardFactory } from "./extensions/secret-guard";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { pickDefaultAvailableModel, resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolvePromptInput } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { registerProvider, reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { scanSkillsFromDir, buildRuleFromMarkdown, loadFilesFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadSecrets, collectEnvSecrets, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { computeContextBreakdown } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { formatShakeSummary } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import * as path from "node:path";

interface Identity {
	platform: string;
	guild: string;
	channel: string;
	thread: string;
	user: string;
}

interface OpenSessionParams {
	sessionId: string;
	cwd: string;
	sessionDir: string;
	continueFromFile: string | null;
	appendSystemPrompt: string | null;
	model: string | null;
	identity: Identity;
}

interface SharedHost {
	agentDir: string;
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	defaultModel: Model;
}

interface UiResponse {
	cancelled?: boolean;
	timedOut?: boolean;
	value?: string;
	confirmed?: boolean;
}

interface PendingUi {
	resolve: (response: UiResponse) => void;
}

interface UiDialogOptions {
	timeout?: number;
}

interface HostSession {
	params: OpenSessionParams;
	session: AgentSession;
	registry: AgentRegistry;
	unsubscribe: () => void;
	pendingUi: Map<string, PendingUi>;
	touchedAt: number;
}

type Json = Record<string, unknown>;

const sessions = new Map<string, HostSession>();

function pendingJobCount(session: AgentSession): number {
	const manager = session.asyncJobManager;
	const running = manager ? manager.getRunningJobs().length : 0;
	const pending = manager?.hasPendingDeliveries() ? 1 : 0;
	const buffered = session.yieldQueue.has("async-result") ? 1 : 0;
	return running + pending + buffered;
}

const HOST_IDLE_MS = 30 * 60 * 1000;
const idleSweep = setInterval(() => {
	const now = Date.now();
	for (const [sessionId, hostSession] of sessions) {
		if (now - hostSession.touchedAt <= HOST_IDLE_MS) continue;
		if (pendingJobCount(hostSession.session) > 0) continue;
		sessions.delete(sessionId);
		void disposeSession(hostSession);
	}
}, 5 * 60 * 1000);
idleSweep.unref();

const CAMOFOX_DISABLE_VALUES: Record<string, true> = { "0": true, false: true, off: true, no: true };
const camofoxFlag = process.env.CAMOFOX_ENABLED;
const camofoxEnabled = camofoxFlag === undefined ? true : !CAMOFOX_DISABLE_VALUES[camofoxFlag.toLowerCase()];

const profileDir = process.env.PICO_PROFILE_DIR;
if (profileDir) {
	registerProvider("skills", {
		id: "pico-profile",
		displayName: "Pico Profile",
		description: "Per-profile skills and rules from the active pico profile",
		priority: 150,
		load: async ctx => scanSkillsFromDir(ctx, { dir: path.join(profileDir, "skills"), providerId: "pico-profile", level: "user" }),
	});
	registerProvider("rules", {
		id: "pico-profile",
		displayName: "Pico Profile",
		description: "Per-profile skills and rules from the active pico profile",
		priority: 150,
		load: async ctx =>
			loadFilesFromDir(ctx, path.join(profileDir, "rules"), "pico-profile", "user", {
				extensions: ["md", "mdc"],
				transform: (name, content, p, source) => buildRuleFromMarkdown(name, content, p, source),
			}),
	});
}

registerProvider("skills", {
	id: "pico-builtin",
	displayName: "Pico Builtin",
	description: "Skills shipped with pico, introducing its features and settings",
	priority: 100,
	load: async ctx => scanSkillsFromDir(ctx, { dir: path.join(import.meta.dir, "..", "skills"), providerId: "pico-builtin", level: "user" }),
});

let shared!: SharedHost;

function asRecord(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

async function buildPromptImages(raw: unknown): Promise<ImageContent[]> {
	if (!Array.isArray(raw)) return [];
	const images: ImageContent[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const mimeType = str(record.mimeType);
		const data = str(record.data);
		if (!mimeType || !data) continue;
		try {
			const resized = await resizeImage({ type: "image", data, mimeType });
			images.push({ type: "image", mimeType: resized.mimeType, data: resized.data });
		} catch {
			images.push({ type: "image", mimeType, data });
		}
	}
	return images;
}

async function deliverPrompt(session: AgentSession, message: string, rawImages: unknown): Promise<void> {
	const images = await buildPromptImages(rawImages);
	await session.prompt(message, images.length ? { images } : undefined);
}

function nextUiId(): string {
	return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emit(frame: object): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: string, sessionId: string, command: string, success: boolean, error?: string): void {
	emit({ type: "response", id, sessionId, command, success, ...(error ? { error } : {}) });
}

function respondWithResult(id: string, sessionId: string, command: string, result: string): void {
	emit({ type: "response", id, sessionId, command, success: true, result });
}

function emitError(sessionId: string, message: string): void {
	emit({ type: "error", sessionId, message });
}

async function disposeSession(hostSession: HostSession): Promise<void> {
	for (const pending of hostSession.pendingUi.values()) {
		pending.resolve({ cancelled: true, timedOut: false });
	}
	hostSession.pendingUi.clear();
	hostSession.unsubscribe();
	await hostSession.session.dispose().catch(() => {});
}

class SessionUIContext {
	readonly #sessionId: string;
	readonly #pending: Map<string, PendingUi>;

	constructor(sessionId: string, pending: Map<string, PendingUi>) {
		this.#sessionId = sessionId;
		this.#pending = pending;
	}

	#ask(method: string, request: object): Promise<UiResponse> {
		const id = nextUiId();
		const { promise, resolve } = Promise.withResolvers<UiResponse>();
		this.#pending.set(id, { resolve });
		emit({ type: "extension_ui_request", sessionId: this.#sessionId, id, method, ...request });
		return promise;
	}

	#fire(method: string, request: object): void {
		emit({ type: "extension_ui_request", sessionId: this.#sessionId, id: nextUiId(), method, ...request });
	}

	async select(
		title: string,
		options: ReadonlyArray<string | { label?: string }>,
		dialogOptions?: UiDialogOptions,
	): Promise<string | undefined> {
		const labels = options.map(option => (typeof option === "string" ? option : (option.label ?? "")));
		const response = await this.#ask("select", { title, options: labels, timeout: dialogOptions?.timeout });
		return response.cancelled ? undefined : response.value;
	}

	async confirm(title: string, message: string, dialogOptions?: UiDialogOptions): Promise<boolean> {
		const response = await this.#ask("confirm", { title, message, timeout: dialogOptions?.timeout });
		return response.cancelled ? false : response.confirmed === true;
	}

	async input(title: string, placeholder?: string, dialogOptions?: UiDialogOptions): Promise<string | undefined> {
		const response = await this.#ask("input", { title, placeholder, timeout: dialogOptions?.timeout });
		return response.cancelled ? undefined : response.value;
	}

	async editor(title: string, prefill?: string, dialogOptions?: UiDialogOptions): Promise<string | undefined> {
		const response = await this.#ask("editor", { title, prefill, timeout: dialogOptions?.timeout });
		return response.cancelled ? undefined : response.value;
	}

	notify(message: string, notifyType?: "info" | "warning" | "error"): void {
		this.#fire("notify", { message, notifyType });
	}

	setStatus(key: string, text: string | undefined): void {
		this.#fire("setStatus", { statusKey: key, statusText: text });
	}

	setWidget(key: string, content: unknown, options?: { placement?: string }): void {
		if (content === undefined || Array.isArray(content)) {
			this.#fire("setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
		}
	}

	setTitle(title: string): void {
		this.#fire("setTitle", { title });
	}

	setEditorText(text: string): void {
		this.#fire("set_editor_text", { text });
	}

	pasteToEditor(text: string): void {
		this.#fire("set_editor_text", { text });
	}

	getEditorText(): string {
		return "";
	}

	onTerminalInput(): () => void {
		return () => {};
	}

	setWorkingMessage(): void {}
	setFooter(): void {}
	setHeader(): void {}
	setEditorComponent(): void {}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(): void {}

	async custom(): Promise<undefined> {
		return undefined;
	}

	get theme() {
		return theme;
	}

	async getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return [];
	}

	async getTheme(): Promise<undefined> {
		return undefined;
	}

	async setTheme(): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "theme switching not supported in pico host" };
	}
}

async function initHost(cwd: string): Promise<SharedHost> {
	const agentDir = getAgentDir();
	const settings = await Settings.init({ cwd, agentDir });
	const authStorage = await discoverAuthStorage(agentDir);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh("online-if-uncached").catch(() => {});
	const available = modelRegistry.getAvailable();
	const defaultModel =
		resolveRoleSelection(["default"], settings, available, modelRegistry)?.model ??
		pickDefaultAvailableModel(available) ??
		available[0];
	if (!defaultModel) throw new Error("no available model resolved from registry");
	return { agentDir, settings, authStorage, modelRegistry, defaultModel };
}

function resolveModelSelector(selector: string): Model {
	if (!selector) return shared.defaultModel;
	const available = shared.modelRegistry.getAvailable();
	const slash = selector.indexOf("/");
	if (slash > 0) {
		const provider = selector.slice(0, slash);
		const id = selector.slice(slash + 1);
		const exact = available.find(model => model.provider === provider && model.id === id);
		if (exact) return exact;
	}
	const fuzzy =
		available.find(model => model.id === selector) ??
		available.find(model => `${model.provider}/${model.id}` === selector);
	return fuzzy ?? shared.defaultModel;
}

async function runCompletion(id: string, system: string, prompt: string): Promise<void> {
	try {
		const model =
			resolveRoleSelection(["smol", "default"], shared.settings, shared.modelRegistry.getAvailable(), shared.modelRegistry)
				?.model ?? shared.defaultModel;
		const stream = streamSimple(
			model,
			{
				systemPrompt: system ? [system] : [],
				messages: [{ role: "user", content: prompt, timestamp: Date.now(), attribution: "user" }],
			},
			{
				apiKey: shared.modelRegistry.resolver(model),
				maxTokens: 64,
				disableReasoning: true,
			},
		);
		let text = "";
		for await (const event of stream) {
			if (event.type === "text_delta") text += event.delta;
			else if (event.type === "error") throw new Error(event.error.errorMessage ?? "completion stream error");
		}
		emit({ type: "response", id, command: "completion", success: true, result: text });
	} catch (e) {
		emit({ type: "response", id, command: "completion", success: false, error: errorMessage(e) });
	}
}

function buildExtensions(identity: Identity): ExtensionFactory[] {
	const factories: ExtensionFactory[] = [];
	factories.push(makeSecretGuardFactory(identity));
	if (camofoxEnabled) factories.push(makeCamofoxFactory(identity));
	factories.push(makeScheduleFactory(identity));
	return factories;
}

async function buildObfuscator(cwd: string): Promise<SecretObfuscator | undefined> {
	if (!shared.settings.get("secrets.enabled")) return undefined;
	const fileEntries = await loadSecrets(cwd, shared.agentDir);
	const envEntries = collectEnvSecrets();
	const allEntries = [...envEntries, ...fileEntries];
	if (allEntries.length === 0) return undefined;
	return new SecretObfuscator(allEntries);
}

function parseIdentity(value: unknown): Identity {
	const record = asRecord(value) ?? {};
	return {
		platform: str(record.platform) || "discord",
		guild: str(record.guild),
		channel: str(record.channel),
		thread: str(record.thread),
		user: str(record.user),
	};
}

async function constructSession(params: OpenSessionParams): Promise<HostSession> {
	AsyncJobManager.setInstance(undefined);
	resetCapabilities();
	const registry = new AgentRegistry();
	const sessionManager = params.continueFromFile
		? await SessionManager.open(params.continueFromFile, params.sessionDir)
		: SessionManager.create(params.cwd, params.sessionDir);
	const pendingUi = new Map<string, PendingUi>();
	const uiContext = new SessionUIContext(params.sessionId, pendingUi);
	const obfuscator = await buildObfuscator(params.cwd);
	const result = await createAgentSession({
		cwd: params.cwd,
		sessionManager,
		agentRegistry: registry,
		appendSystemPrompt: await resolvePromptInput(params.appendSystemPrompt ?? undefined, "append system prompt"),
		model: resolveModelSelector(params.model ?? ""),
		extensions: buildExtensions(params.identity),
		obfuscator,
		agentDir: shared.agentDir,
		settings: shared.settings,
		authStorage: shared.authStorage,
		modelRegistry: shared.modelRegistry,
		skipPythonPreflight: true,
	});
	result.setToolUIContext(uiContext, true);
	await initializeExtensions(result.session, {
		reportSendError: (action, error) => emitError(params.sessionId, `${action}: ${error.message}`),
		reportRuntimeError: error => emitError(params.sessionId, `extension error: ${errorMessage(error.error)}`),
		uiContext,
	});
	const hostSession: HostSession = {
		params,
		session: result.session,
		registry,
		unsubscribe: () => {},
		pendingUi,
		touchedAt: Date.now(),
	};
	hostSession.unsubscribe = result.session.subscribe((event: AgentSessionEvent) => {
		hostSession.touchedAt = Date.now();
		emit({ ...event, sessionId: params.sessionId });
	});
	return hostSession;
}

async function openSession(raw: Json, id: string, sessionId: string): Promise<void> {
	if (sessions.has(sessionId)) {
		respond(id, sessionId, "open_session", true);
		return;
	}
	try {
		const params: OpenSessionParams = {
			sessionId,
			cwd: str(raw.cwd),
			sessionDir: str(raw.sessionDir),
			continueFromFile: typeof raw.continueFromFile === "string" ? raw.continueFromFile : null,
			appendSystemPrompt: typeof raw.appendSystemPrompt === "string" ? raw.appendSystemPrompt : null,
			model: typeof raw.model === "string" ? raw.model : null,
			identity: parseIdentity(raw.identity),
		};
		const hostSession = await constructSession(params);
		sessions.set(sessionId, hostSession);
		respond(id, sessionId, "open_session", true);
	} catch (e) {
		const message = errorMessage(e);
		emitError(sessionId, message);
		respond(id, sessionId, "open_session", false, message);
	}
}

async function runCommand(
	id: string,
	sessionId: string,
	command: string,
	action: () => Promise<unknown>,
): Promise<void> {
	try {
		await action();
		respond(id, sessionId, command, true);
	} catch (e) {
		const message = errorMessage(e);
		emitError(sessionId, message);
		respond(id, sessionId, command, false, message);
	}
}

async function newSession(id: string, sessionId: string, hostSession: HostSession): Promise<void> {
	try {
		await disposeSession(hostSession);
		const fresh = await constructSession({ ...hostSession.params, continueFromFile: null });
		sessions.set(sessionId, fresh);
		respond(id, sessionId, "new_session", true);
	} catch (e) {
		const message = errorMessage(e);
		emitError(sessionId, message);
		respond(id, sessionId, "new_session", false, message);
	}
}

async function closeSession(id: string, sessionId: string, hostSession: HostSession): Promise<void> {
	sessions.delete(sessionId);
	await disposeSession(hostSession);
	respond(id, sessionId, "close_session", true);
}

function routeUiResponse(sessionId: string, raw: Json): void {
	const hostSession = sessions.get(sessionId);
	if (!hostSession) return;
	const requestId = str(raw.id);
	const pending = hostSession.pendingUi.get(requestId);
	if (!pending) return;
	hostSession.pendingUi.delete(requestId);
	pending.resolve({
		cancelled: raw.cancelled === true,
		timedOut: raw.timedOut === true,
		value: typeof raw.value === "string" ? raw.value : undefined,
		confirmed: typeof raw.confirmed === "boolean" ? raw.confirmed : undefined,
	});
}

async function handle(raw: Json): Promise<void> {
	const type = str(raw.type);
	const sessionId = str(raw.sessionId);
	const id = str(raw.id);

	if (type === "open_session") {
		await openSession(raw, id, sessionId);
		return;
	}
	if (type === "extension_ui_response") {
		routeUiResponse(sessionId, raw);
		return;
	}
	if (type === "completion") {
		void runCompletion(id, str(raw.system), str(raw.prompt));
		return;
	}

	const hostSession = sessions.get(sessionId);
	if (!hostSession) {
		emitError(sessionId, `unknown or closed session ${sessionId}`);
		respond(id, sessionId, type, false, `unknown session ${sessionId}`);
		return;
	}
	hostSession.touchedAt = Date.now();

	switch (type) {
		case "prompt": {
			if (hostSession.session.isStreaming) {
				emitError(sessionId, "session is busy: a turn is already streaming");
				respond(id, sessionId, type, false, "session busy");
				return;
			}
			respond(id, sessionId, "prompt", true);
			void deliverPrompt(hostSession.session, str(raw.message), raw.images).catch((e: unknown) => emitError(sessionId, errorMessage(e)));
			return;
		}
		case "steer":
			await runCommand(id, sessionId, type, () => hostSession.session.steer(str(raw.message)));
			return;
		case "follow_up":
			await runCommand(id, sessionId, type, () => hostSession.session.followUp(str(raw.message)));
			return;
		case "abort":
			await runCommand(id, sessionId, type, () => hostSession.session.abort({ reason: USER_INTERRUPT_LABEL }));
			return;
		case "set_session_name":
			await runCommand(id, sessionId, type, () => hostSession.session.setSessionName(str(raw.name)));
			return;
		case "set_model": {
			const provider = str(raw.provider);
			const modelId = str(raw.modelId);
			const model = shared.modelRegistry.getAvailable().find(m => m.provider === provider && m.id === modelId);
			if (!model) {
				const message = `no available model ${provider}/${modelId}`;
				emitError(sessionId, message);
				respond(id, sessionId, type, false, message);
				return;
			}
			await runCommand(id, sessionId, type, () => hostSession.session.setModel(model));
			return;
		}
		case "context": {
			try {
				const text = buildDiscordContextReport(hostSession.session);
				respondWithResult(id, sessionId, type, text);
			} catch (e) {
				const m = errorMessage(e);
				emitError(sessionId, m);
				respond(id, sessionId, type, false, m);
			}
			return;
		}
		case "compact": {
			const focus = raw.focus ? str(raw.focus) : undefined;
			void (async () => {
				const before = hostSession.session.getContextUsage?.()?.tokens;
				try {
					await hostSession.session.compact(focus, undefined);
				} catch (e) {
					const m = errorMessage(e);
					emitError(sessionId, m);
					respond(id, sessionId, type, false, m);
					return;
				}
				const after = hostSession.session.getContextUsage?.()?.tokens;
				const text =
					before != null && after != null
						? `Compaction complete. Tokens: ${before} -> ${after} (saved ${before - after}).`
						: "Compaction complete.";
				respondWithResult(id, sessionId, type, text);
			})();
			return;
		}
		case "shake": {
			const mode = str(raw.mode) || "elide";
			try {
				const result = await hostSession.session.shake(mode as any);
				respondWithResult(id, sessionId, type, formatShakeSummary(result));
			} catch (e) {
				const m = errorMessage(e);
				emitError(sessionId, m);
				respond(id, sessionId, type, false, m);
			}
			return;
		}
		case "job_state": {
			respondWithResult(id, sessionId, type, String(pendingJobCount(hostSession.session)));
			return;
		}
		case "new_session":
			await newSession(id, sessionId, hostSession);
			return;
		case "close_session":
			await closeSession(id, sessionId, hostSession);
			return;
		default:
			respond(id, sessionId, type, false, `unknown command ${type}`);
	}
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) yield line;
			newline = buffer.indexOf("\n");
		}
	}
	const tail = buffer.trim();
	if (tail) yield tail;
}

function buildDiscordContextReport(session: AgentSession): string {
	const b = computeContextBreakdown(session);
	if (b.contextWindow <= 0) {
		return "Context usage is unavailable: no model is selected for this session.";
	}
	const rows: [string, number][] = [];
	for (const category of b.categories) {
		if (category.tokens > 0) rows.push([category.label, category.tokens]);
	}
	if (b.autoCompactBufferTokens > 0) rows.push(["Auto-compact", b.autoCompactBufferTokens]);
	if (b.freeTokens > 0) rows.push(["Free", b.freeTokens]);
	const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
	const tokenWidth = Math.max(0, ...rows.map(([, tokens]) => formatNumber(tokens).length));
	const usedPct = Math.round((b.usedTokens / b.contextWindow) * 100);
	const lines = [
		`Context: ${formatNumber(b.usedTokens)} / ${formatNumber(b.contextWindow)} tokens (${usedPct}% used)`,
		"",
	];
	for (const [label, tokens] of rows) {
		const rowPct = `${Math.round((tokens / b.contextWindow) * 100)}%`;
		lines.push(`${label.padEnd(labelWidth)}  ${formatNumber(tokens).padStart(tokenWidth)}  ${rowPct.padStart(4)}`);
	}
	return lines.join("\n");
}

shared = await initHost(process.cwd());
emit({ type: "ready" });

for await (const line of readLines(Bun.stdin.stream())) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		continue;
	}
	const record = asRecord(parsed);
	if (!record) continue;
	void handle(record).catch(e => emitError(str(record.sessionId), errorMessage(e)));
}
