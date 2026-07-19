import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
} from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import type { SessionLike } from "../../engine/conversations";
import { log } from "../../util/log";
import type { DiscordHub } from "./adapter";

const logger = log(["discord"]);

export interface Gateway {
  botUserId: string;
  stop: () => Promise<void>;
}

export async function startGateway<S extends SessionLike>(
  token: string,
  hub: (botUserId: string) => DiscordHub<S>,
): Promise<Gateway> {
  const rest = new REST({ version: "10" }).setToken(token);
  const gateway = new WebSocketManager({
    token,
    intents:
      GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.MessageContent,
    rest,
  });
  const client = new Client({ rest, gateway });

  const ready = Promise.withResolvers<string>();
  client.once(GatewayDispatchEvents.Ready, ({ data }) => {
    logger.info("gateway ready as {user}", { user: data.user.username });
    ready.resolve(data.user.id);
  });

  await gateway.connect();
  const botUserId = await ready.promise;
  const bridge = hub(botUserId);

  client.on(GatewayDispatchEvents.MessageCreate, ({ api, data }) => {
    void bridge.onMessageCreate(api, data).catch((e: unknown) => {
      logger.error("message handling failed: {error}", { error: e });
    });
  });

  return {
    botUserId,
    stop: async () => {
      await gateway.destroy();
    },
  };
}
