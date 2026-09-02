import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type * as AgentMessage from "@pico/contract/agent-message";

type OmpPromptSession = Parameters<typeof tryRunRpcSkillCommand>[0] &
  Pick<OmpAgentSession.AgentSession, "sendUserMessage">;

export const makeOmpPromptSender = (session: OmpPromptSession) =>
  async function sendPrompt(prompt: AgentMessage.AgentPrompt): Promise<void> {
    const skillResult = await tryRunRpcSkillCommand(session, prompt, "steer");
    if (skillResult !== false) return;
    await session.sendUserMessage(prompt);
  };
