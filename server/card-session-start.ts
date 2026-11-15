import type { PaseoApi } from "@getpaseo/client";
import { effectiveAgentModel, type AgentModel } from "../shared/agent-defaults";
import { isSummarizer } from "../shared/summary";
import { agentSessionConfig, preparedSessionLaunch } from "../shared/session-start";
import { ToolError } from "./tool-error";
import type { ToolServer } from "./tool-server";

export const DEFAULT_FIRST_PROMPT = "Work on this card.";
const AGENT_PAGE_SIZE = 200;
const FINAL_STATUSES: readonly string[] = ["done", "cancelled"];

export type CardSessionStartDependencies = {
  tools: ToolServer;
  paseo: PaseoApi;
  hostModel: () => Promise<AgentModel | null>;
};

export type CardSessionStartInput = {
  taskId: string;
  operationId: string;
  prompt?: string;
  model?: AgentModel;
};

export type CardSessionStartResult = { agentId: string; started: boolean };

async function liveSessionId(paseo: PaseoApi, workspaceId: string) {
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: AGENT_PAGE_SIZE, cursor },
    });
    const live = page.entries.find(
      ({ agent }) => agent.workspaceId === workspaceId && !agent.archivedAt && !isSummarizer(agent),
    );
    if (live) return live.agent.id;
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

async function existingPreparedAgent(paseo: PaseoApi, agentId: string, workspaceId: string) {
  const found = (await paseo.agents.ref(agentId).refresh())?.agent;
  return found && found.workspaceId === workspaceId && !found.archivedAt ? found.id : null;
}

export async function startCardSession(
  { tools, paseo, hostModel }: CardSessionStartDependencies,
  { taskId, operationId, prompt, model }: CardSessionStartInput,
): Promise<CardSessionStartResult> {
  const board = await tools.store.read();
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
  const project = board.projects.find((candidate) => candidate.id === task.projectId);
  if (task.archivedAt || project?.archivedAt) throw new ToolError("ARCHIVED", "Task or project is archived.");
  if (FINAL_STATUSES.includes(task.status))
    throw new ToolError("TASK_FINISHED", "The card is finished; move it back to start a session.");

  const liveId = await liveSessionId(paseo, task.workspaceId);
  if (liveId) return { agentId: liveId, started: false };

  const chosen = model ?? effectiveAgentModel(project, await hostModel())?.model;
  if (!chosen)
    throw new ToolError("MODEL_REQUIRED", "Give a model, or set a default model in the Flowly settings.");

  const preparation = await tools.prepareSession(taskId, operationId, paseo);
  const launch = preparedSessionLaunch(preparation);
  try {
    const created = await paseo.workspaces.ref(task.workspaceId).agents.create({
      config: agentSessionConfig(chosen, preparation.instructions),
      ...launch,
      title: task.title,
      labels: { "flowly-task": task.id },
      prompt: prompt?.trim() || DEFAULT_FIRST_PROMPT,
    });
    if (created.id !== preparation.agentId)
      throw new ToolError(
        "SERVICE_FAILURE",
        "Paseo returned a different session ID; inspect the workspace before retrying.",
      );
    return { agentId: created.id, started: true };
  } catch (error) {
    const recovered = await existingPreparedAgent(paseo, preparation.agentId, task.workspaceId);
    if (recovered) return { agentId: recovered, started: false };
    throw error;
  }
}
