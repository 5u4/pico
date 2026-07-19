import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { API, GatewayMessageCreateDispatchData } from "@discordjs/core";
import { ChannelType } from "@discordjs/core";
import { Engine } from "../../engine/conversations";
import {
  getConversationByExternalId,
  getWorkspaceByExternalId,
} from "../../engine/registry";
import { openDb } from "../../store/db";
import { FakeWebSessions } from "../web/fake-session";
import { DiscordHub } from "./adapter";

const BOT_ID = "bot-1";

type Posted = { channelId: string; content: string };

class FakeApi {
  readonly posts: Posted[] = [];
  private readonly channels: Record<
    string,
    { type: ChannelType; parent_id?: string; name?: string }
  >;
  private threadSeq = 0;

  constructor(
    channels: Record<
      string,
      { type: ChannelType; parent_id?: string; name?: string }
    >,
  ) {
    this.channels = channels;
  }

  get api(): API {
    return {
      channels: {
        get: (channelId: string) =>
          Promise.resolve({ id: channelId, ...this.channels[channelId] }),
        createThread: (
          channelId: string,
          body: { name: string },
          _messageId: string,
        ) => {
          this.threadSeq += 1;
          const id = `thread-${this.threadSeq}`;
          this.channels[id] = {
            type: ChannelType.PublicThread,
            parent_id: channelId,
            name: body.name,
          };
          return Promise.resolve({ id });
        },
        createMessage: (channelId: string, body: { content: string }) => {
          this.posts.push({ channelId, content: body.content });
          return Promise.resolve({ id: `msg-${this.posts.length}` });
        },
      },
    } as unknown as API;
  }
}

function message(
  overrides: Partial<GatewayMessageCreateDispatchData>,
): GatewayMessageCreateDispatchData {
  return {
    id: "m-1",
    channel_id: "chan-1",
    guild_id: "guild-1",
    content: "hello",
    author: { id: "user-1", bot: false },
    ...overrides,
  } as GatewayMessageCreateDispatchData;
}

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function makeHub() {
  const engine = new Engine({
    db,
    sessions: new FakeWebSessions(),
    autoTitle: async () => null,
  });
  const hub = new DiscordHub({
    db,
    engine,
    workspaceCwd: "/projects",
    worktreeCwd: "/worktrees",
    botUserId: BOT_ID,
  });
  return { hub, engine };
}

describe("DiscordHub", () => {
  test("a channel message opens a thread and posts the reply", async () => {
    const fake = new FakeApi({
      "chan-1": { type: ChannelType.GuildText, name: "general" },
    });
    const { hub } = makeHub();

    await hub.onMessageCreate(fake.api, message({ content: "first" }));

    const workspace = getWorkspaceByExternalId(db, "discord", "chan-1");
    expect(workspace?.label).toBe("general");
    const conversation = workspace
      ? getConversationByExternalId(db, workspace.id, "thread-1")
      : undefined;
    expect(conversation).toBeDefined();
    expect(fake.posts).toEqual([
      { channelId: "thread-1", content: "echo: first" },
    ]);
  });

  test("a thread message drives the existing conversation", async () => {
    const fake = new FakeApi({
      "chan-1": { type: ChannelType.GuildText, name: "general" },
    });
    const { hub } = makeHub();

    await hub.onMessageCreate(fake.api, message({ content: "open" }));
    await hub.onMessageCreate(
      fake.api,
      message({ channel_id: "thread-1", content: "again" }),
    );

    const workspace = getWorkspaceByExternalId(db, "discord", "chan-1");
    expect(workspace).toBeDefined();
    const conversation = workspace
      ? getConversationByExternalId(db, workspace.id, "thread-1")
      : undefined;
    expect(conversation).toBeDefined();
    expect(fake.posts).toEqual([
      { channelId: "thread-1", content: "echo: open" },
      { channelId: "thread-1", content: "echo: again" },
    ]);
  });

  test("ignores its own bot messages", async () => {
    const fake = new FakeApi({
      "chan-1": { type: ChannelType.GuildText, name: "general" },
    });
    const { hub } = makeHub();

    await hub.onMessageCreate(
      fake.api,
      message({ author: { id: BOT_ID, bot: true } as never }),
    );
    expect(fake.posts).toEqual([]);
  });

  test("ignores empty content", async () => {
    const fake = new FakeApi({
      "chan-1": { type: ChannelType.GuildText, name: "general" },
    });
    const { hub } = makeHub();

    await hub.onMessageCreate(fake.api, message({ content: "   " }));
    expect(fake.posts).toEqual([]);
  });

  test("ignores direct messages without a guild", async () => {
    const fake = new FakeApi({
      "chan-1": { type: ChannelType.GuildText, name: "general" },
    });
    const { hub } = makeHub();

    await hub.onMessageCreate(
      fake.api,
      message({ guild_id: undefined as never }),
    );
    expect(fake.posts).toEqual([]);
  });
});
