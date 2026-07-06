export function makeSecretGuardFactory(identity) {
  return function secretGuard(pi) {
    const DENIED_BASENAMES = ["discord_bot_token", ".envrc"];
    const ALLOWED_ENV_BASENAMES = [".env.example", ".env.sample", ".env.template"];
    const DENIED_DIR_SEGMENTS = [".ssh", ".gnupg", "secrets"];
    const DENIED_COMMAND_TOKENS = [
      ".env",
      ".envrc",
      "discord_bot_token",
      ".ssh",
      ".gnupg",
      "secrets/",
      ".pico/secrets",
      ".config/gh/hosts",
      ".aws/credentials",
    ];

    function normalize(raw) {
      let value = String(raw || "").trim();
      if (value.startsWith("~")) value = value.slice(1);
      return value.replace(/\\/g, "/");
    }

    function basename(pathValue) {
      const trimmed = pathValue.replace(/\/+$/, "");
      const idx = trimmed.lastIndexOf("/");
      const name = idx === -1 ? trimmed : trimmed.slice(idx + 1);
      const colon = name.indexOf(":");
      return colon === -1 ? name : name.slice(0, colon);
    }

    function isSecretEnvBasename(name) {
      if (ALLOWED_ENV_BASENAMES.includes(name)) return false;
      return name === ".env" || name.startsWith(".env.");
    }

    function pathDenied(pathValue) {
      const value = normalize(pathValue);
      if (!value) return false;
      const name = basename(value);
      if (DENIED_BASENAMES.includes(name)) return true;
      if (isSecretEnvBasename(name)) return true;
      const segments = value.split("/").filter(Boolean);
      for (const segment of segments) {
        if (DENIED_DIR_SEGMENTS.includes(segment)) return true;
      }
      if (segments.includes("gh") && (name === "hosts.yml" || name === "hosts.yaml")) return true;
      if (segments.includes(".aws") && name === "credentials") return true;
      return false;
    }

    function commandDenied(commandValue) {
      const value = normalize(commandValue);
      if (!value) return undefined;
      for (const token of DENIED_COMMAND_TOKENS) {
        if (value.includes(token)) return token;
      }
      return undefined;
    }

    function secretPathHit(event) {
      const input = event.input || {};
      let target;
      if (event.toolName === "bash") {
        target = commandDenied(input.command);
      } else if (
        event.toolName === "read" ||
        event.toolName === "edit" ||
        event.toolName === "write" ||
        event.toolName === "grep" ||
        event.toolName === "glob"
      ) {
        const pathValue = input.path;
        if (typeof pathValue === "string" && pathDenied(pathValue)) target = pathValue;
      }
      if (!target) return undefined;
      return `Blocked: '${target}' is a secret-bearing file. pico does not read credentials directly; ask the user to handle it in their own terminal.`;
    }

    pi.on("tool_call", (event) => {
      const deny = secretPathHit(event);
      if (deny) return { block: true, reason: deny };
    });
  };
}
