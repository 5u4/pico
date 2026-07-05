export function makeSecretGuardFactory(identity) {
  return function secretGuard(pi) {
    const DENIED_BASENAMES = [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".env.staging",
      ".envrc",
      "discord_bot_token",
    ];

    const DENIED_SEGMENTS = [
      "/.ssh/",
      "/secrets/",
      "/.pico/secrets",
      ".config/gh/hosts.yml",
      ".config/gh/hosts.yaml",
      ".gnupg/",
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

    function pathDenied(pathValue) {
      const value = normalize(pathValue);
      if (!value) return false;
      if (DENIED_BASENAMES.includes(basename(value))) return true;
      for (const segment of DENIED_SEGMENTS) {
        if (value.includes(segment)) return true;
      }
      return false;
    }

    function commandDenied(commandValue) {
      const value = normalize(commandValue);
      if (!value) return undefined;
      for (const token of DENIED_BASENAMES) {
        if (value.includes(token)) return token;
      }
      for (const segment of DENIED_SEGMENTS) {
        if (value.includes(segment)) return segment;
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
