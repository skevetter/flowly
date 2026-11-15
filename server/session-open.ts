import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { isSummarizer } from "../shared/summary";
import type { ToolServer } from "./tool-server";
import { logFailure } from "./error-report";

const intakeServerName = "flowly-intake";
const providersAcceptingLaunchMcp: readonly string[] = ["claude", "codex"];

/**
 * The `addHook("agent.open.before")` hook: a Kanban-managed interactive
 * session gets its CLI environment and, at launch only, the `flowly` MCP
 * server (PASEO-SESSION-TOOLS-SPEC §4). Never throws: a failure here would
 * keep the session from opening, so it is logged and the request passes on.
 */
export async function openKanbanSession(
  request: PluginSessionOpenRequest,
  tools: Pick<ToolServer, "attach" | "sessionLaunch" | "intakeLaunch">,
  directory: string,
  paseo: PaseoApi,
): Promise<PluginSessionOpenRequest | void> {
  try {
    tools.attach(paseo);
    if (request.purpose !== "interactive") return;
    const launch = await tools.sessionLaunch(request.agentId, request.workspaceId, paseo);
    if (!launch) return await withIntake(request, tools, paseo);
    return {
      ...request,
      env: {
        ...request.env,
        FLOWLY_CONTEXT_FILE: launch.contextFile,
        FLOWLY_CLI: directory + "/flowly.mjs",
        FLOWLY_SKILL: directory + "/SKILL.md",
      },
      // Launch only: Paseo never saves it in the agent config.
      ...(launch.mcp ? { mcpServers: { ...request.mcpServers, flowly: launch.mcp } } : {}),
    };
  } catch (e) {
    logFailure("Kanban session tools unavailable:", e, request.agentId);
  }
}

async function withIntake(
  request: PluginSessionOpenRequest,
  tools: Pick<ToolServer, "intakeLaunch">,
  paseo: PaseoApi,
): Promise<PluginSessionOpenRequest | void> {
  if (isSummarizer(request) || !providersAcceptingLaunchMcp.includes(request.provider)) return;
  const intake = await tools.intakeLaunch(request.agentId, request.workspaceId, paseo);
  if (!intake) return;
  return { ...request, mcpServers: { ...request.mcpServers, [intakeServerName]: intake } };
}
