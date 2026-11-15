import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { cardToolNames, cardToolServer } from "../shared/card-tools";
import { logFailure } from "./error-report";

const ownCardToolNames: ReadonlySet<string> = new Set(cardToolNames.map((tool) => `mcp__${cardToolServer}__${tool}`));

export const isOwnCardToolRequest = (request: Pick<AgentPermissionRequest, "kind" | "name">) =>
  request.kind === "tool" && ownCardToolNames.has(request.name);

export async function allowOwnCardTool(paseo: PaseoApi, agentId: string, request: AgentPermissionRequest) {
  if (!isOwnCardToolRequest(request)) return false;
  try {
    await paseo.agents.ref(agentId).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
    return true;
  } catch (error) {
    logFailure("Flowly card tool request not approved:", error, agentId);
    return false;
  }
}
