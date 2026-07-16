import { createConnection } from "node:net";
import { err, ok, type Result } from "neverthrow";
import { errMessage } from "../util/result";

const READY_TIMEOUT_MS = 10_000;

export function reportReady(
  socketPath: string,
  token: string,
): Promise<Result<void, string>> {
  const { promise, resolve } = Promise.withResolvers<Result<void, string>>();

  const socket = createConnection({ path: socketPath });
  const timer = setTimeout(() => {
    socket.destroy();
    resolve(err(`ready handshake timed out after ${READY_TIMEOUT_MS}ms`));
  }, READY_TIMEOUT_MS);

  const settle = (result: Result<void, string>): void => {
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };

  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ cmd: "ready", token })}\n`);
  });
  socket.on("data", () => settle(ok()));
  socket.on("error", (e) => settle(err(errMessage(e))));
  socket.on("close", () =>
    settle(err("supervisor closed the socket before acking")),
  );

  return promise;
}
