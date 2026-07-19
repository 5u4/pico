import type { Database } from "bun:sqlite";
import type {
  API,
  APIChannel,
  GatewayMessageCreateDispatchData,
} from "@discordjs/core";
import { ChannelType } from "@discordjs/core";
import { Mutex } from "async-mutex";
import type { Engine, SessionLike } from "../../engine/conversations";
import { provisionConversation } from "../../engine/provision";
import {
  createWorkspace,
  getConversationByExternalId,
  getWorkspaceByExternalId,
} from "../../engine/registry";
import type { Conversation, Workspace } from "../../store/schema";
import { log } from "../../util/log";
import { renderReply } from "./render";

const PLATFORM = "discord" as const;

const logger = log(["discord"]);

export interface DiscordHubDeps<S extends SessionLike = SessionLike> {
  db: Database;
  engine: Engine<S>;
  workspaceCwd: string;
  worktreeCwd: string;
  botUserId: string;
}

export class DiscordHub<S extends SessionLike = SessionLike> {
  private readonly deps: DiscordHubDeps<S>;
  private readonly locks = new Map<string, Mutex>();

  constructor(deps: DiscordHubDeps<S>) {
    this.deps = deps;
  }

  async onMessageCreate(
    api: API,
    message: GatewayMessageCreateDispatchData,
  ): Promise<void> {
    if (message.author.bot || message.author.id === this.deps.botUserId) return;
    if (!message.guild_id) return;
    const prompt = message.content.trim();
    if (prompt.length === 0) return;

    const channel = await api.channels.get(message.channel_id);
    const inThread =
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread;
    const boundChannel = inThread ? threadParent(channel) : channel.id;
    if (!boundChannel) return;

    const workspace = await this.resolveWorkspace(
      boundChannel,
      channelLabel(channel),
    );

    if (inThread) {
      await this.lockFor(`t:${channel.id}`).runExclusive(() =>
        this.driveThread(api, workspace, channel.id, prompt),
      );
      return;
    }
    await this.openThread(api, workspace, message, prompt);
  }

  private resolveWorkspace(
    channelId: string,
    label: string,
  ): Promise<Workspace> {
    return this.lockFor(`w:${channelId}`).runExclusive(() => {
      const existing = getWorkspaceByExternalId(
        this.deps.db,
        PLATFORM,
        channelId,
      );
      if (existing) return existing;
      return createWorkspace(this.deps.db, {
        cwd: this.deps.workspaceCwd,
        platform: PLATFORM,
        label,
        externalId: channelId,
      });
    });
  }

  private async openThread(
    api: API,
    workspace: Workspace,
    message: GatewayMessageCreateDispatchData,
    prompt: string,
  ): Promise<void> {
    const thread = await api.channels.createThread(
      message.channel_id,
      { name: threadName(prompt) },
      message.id,
    );
    const provisioned = await provisionConversation(
      this.deps.db,
      workspace,
      this.deps.worktreeCwd,
      null,
      thread.id,
    );
    if (provisioned.isErr()) {
      logger.error("provision failed: {error}", { error: provisioned.error });
      await this.post(api, thread.id, `❌ ${provisioned.error}`);
      return;
    }
    await this.runTurn(api, provisioned.value, thread.id, prompt);
  }

  private async driveThread(
    api: API,
    workspace: Workspace,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    const existing = getConversationByExternalId(
      this.deps.db,
      workspace.id,
      threadId,
    );
    const conversation =
      existing ?? (await this.adoptThread(workspace, threadId));
    if (!conversation) return;
    await this.runTurn(api, conversation, threadId, prompt);
  }

  private async adoptThread(
    workspace: Workspace,
    threadId: string,
  ): Promise<Conversation | undefined> {
    const provisioned = await provisionConversation(
      this.deps.db,
      workspace,
      this.deps.worktreeCwd,
      null,
      threadId,
    );
    if (provisioned.isErr()) {
      logger.error("adopt thread failed: {error}", {
        error: provisioned.error,
      });
      return undefined;
    }
    return provisioned.value;
  }

  private lockFor(conversationId: string): Mutex {
    let lock = this.locks.get(conversationId);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(conversationId, lock);
    }
    return lock;
  }

  private async runTurn(
    api: API,
    conversation: Conversation,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    await this.lockFor(conversation.id).runExclusive(async () => {
      const result = await this.deps.engine.prompt(
        conversation.id,
        conversation.cwd,
        prompt,
      );
      if (result.isErr()) {
        await this.post(api, threadId, `❌ ${result.error}`);
        return;
      }
      const snapshot = this.deps.engine.snapshot(conversation.id);
      const chunks = snapshot ? renderReply(snapshot.messages) : [];
      if (chunks.length === 0) {
        await this.post(api, threadId, "(no reply)");
        return;
      }
      for (const chunk of chunks) await this.post(api, threadId, chunk);
    });
  }

  private async post(
    api: API,
    channelId: string,
    content: string,
  ): Promise<void> {
    try {
      await api.channels.createMessage(channelId, { content });
    } catch (e) {
      logger.error("post failed: {error}", { error: e });
    }
  }
}

function threadParent(channel: APIChannel): string | undefined {
  if ("parent_id" in channel && channel.parent_id) return channel.parent_id;
  return undefined;
}

function channelLabel(channel: APIChannel): string {
  if ("name" in channel && channel.name) return channel.name;
  return channel.id;
}

function threadName(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0] ?? prompt;
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return "conversation";
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`;
}
