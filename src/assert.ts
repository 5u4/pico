export function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}
