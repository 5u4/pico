import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { isLowSignalTitleInput } from "@oh-my-pi/pi-coding-agent/tiny/text";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

export function autoTitle(
  session: AgentSession,
  text: string,
): Promise<string | null> {
  if (process.env.PI_NO_TITLE || isLowSignalTitleInput(text)) {
    return Promise.resolve(null);
  }
  return generateSessionTitle(
    text,
    session.modelRegistry,
    session.settings,
    session.sessionId,
    session.model,
    (provider) => session.agent.metadataForProvider(provider),
    session.titleSystemPrompt,
  );
}

const PROVISIONAL_TITLE_MAX = 60;

export function provisionalTitle(text: string): string | null {
  const line = (text.trim().split(/\r?\n/, 1)[0] ?? "").trim();
  if (!line) return null;
  return line.length > PROVISIONAL_TITLE_MAX
    ? `${line.slice(0, PROVISIONAL_TITLE_MAX).trimEnd()}…`
    : line;
}
