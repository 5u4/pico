import { Effect } from "effect";

export class Core extends Effect.Service<Core>()("pico/Core", {
  succeed: {
    greet: (name: string) => Effect.succeed(`hello, ${name}`),
  },
}) {}
