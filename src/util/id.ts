import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export function newId(): string {
  return ulid();
}
