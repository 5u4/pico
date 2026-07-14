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
