import { createConnection } from "node:net";

const [port, identity] = process.argv.slice(2);
if (port === undefined || identity === undefined) {
  throw new Error("Expected control port and transport identity");
}

process.on("SIGTERM", () => undefined);
const connection = createConnection({ host: "127.0.0.1", port: Number(port) });
// Cleanup uses the owned connection, never a PID that could have been reused.
const stop = () => process.kill(process.pid, "SIGKILL");
connection.on("error", stop);
connection.on("end", stop);
connection.on("close", stop);
connection.on("connect", () => {
  connection.write(`${JSON.stringify({ identity, pid: process.pid })}\n`);
});
connection.resume();
