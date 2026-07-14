import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export function newId(): string {
  return ulid();
}

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(id: string): boolean {
  return ulidPattern.test(id);
}
