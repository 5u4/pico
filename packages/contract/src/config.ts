import * as Schema from "effect/Schema";
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "./path.ts";

export const PicoRoot = AbsolutePath.pipe(Schema.brand("@pico/contract/PicoRoot"));
export type PicoRoot = typeof PicoRoot.Type;

export interface PicoPaths {
  readonly root: PicoRoot;
  readonly configFile: AbsolutePathType;
  readonly storeFile: AbsolutePathType;
  readonly sessionsDir: AbsolutePathType;
  readonly secretsDir: AbsolutePathType;
  readonly worktreesDir: AbsolutePathType;
  readonly logsDir: AbsolutePathType;
}
