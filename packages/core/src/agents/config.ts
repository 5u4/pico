import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

export class ChatsConfig extends Effect.Service<ChatsConfig>()(
  "pico/ChatsConfig",
  {
    sync: () => ({ sessionsRoot: join(homedir(), ".pico", "sessions") }),
  },
) {}

export const layerChatsConfig = (
  sessionsRoot: string,
): Layer.Layer<ChatsConfig> =>
  Layer.succeed(ChatsConfig, ChatsConfig.make({ sessionsRoot }));
