import type { AgentModel } from "./agent-defaults";
import type { ToolPreparation } from "./tools";

export const CARD_SESSION_IDEMPOTENCY_PREFIX = "ultra-kanban-session:";

export function agentSessionConfig(model: AgentModel, systemPrompt: string) {
  return {
    provider: `${model.provider}/${model.model}`,
    systemPrompt,
    ...(model.mode ? { modeId: model.mode } : {}),
    ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
  };
}

export function preparedSessionLaunch(preparation: ToolPreparation) {
  return {
    agentId: preparation.agentId,
    idempotencyKey: `${CARD_SESSION_IDEMPOTENCY_PREFIX}${preparation.agentId}`,
    env: {
      FLOWLY_CONTEXT_FILE: preparation.contextFile,
      FLOWLY_CLI: preparation.cliPath,
      FLOWLY_SKILL: preparation.skillPath,
    },
  };
}
