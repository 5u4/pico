import * as Schema from "effect/Schema";

export const AbsolutePath = Schema.String.pipe(Schema.brand("@pico/contract/AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;
