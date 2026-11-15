import type { PaseoApi } from "@getpaseo/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  intakeCreateInputSchema,
  intakeCreateResultSchema,
  intakeProjectsInputSchema,
  intakeProjectsResultSchema,
  type IntakeIdentity,
} from "../shared/intake";
import { intakeDisabledMessage, type IntakeTools } from "./intake";
import { ToolError, toolResult } from "./tool-error";

const projectsDescription =
  "Lists the Flowly projects (Kanban boards) where a card can be created, with what flowly_intake_create_card needs: each project's id, title and primaryPath, the statuses a new card may start in (status ids with the lane names the user sees), whether worktree mode is available (worktree.available, with defaultBaseRef), and the tracker connections (id, provider, label) that can read items for it. Call it before flowly_intake_create_card to choose the projectId and, when several connections could read the same item, the connectionId. Read-only. Returns INTAKE_DISABLED when the user has not turned on Agent intake in Flowly settings.";

const createDescription =
  "Creates one Flowly card from tracker items: Jira keys (PROJ-12), GitHub or GitLab issues, pull or merge requests (group/repo#12, group/repo!7) or item URLs of a connected service. Each item is read from its service and attached to the card as an input the card's own agent reads; Flowly never changes the item. The title defaults to the first item's title and the status to todo. Pass projectId and the statuses from flowly_intake_projects. When an item fits several connections the call fails with INTAKE_AMBIGUOUS_CONNECTION naming them: retry with connectionId. INTAKE_NO_CONNECTION means no connection can read the item. If any item is already an input of a live card in the project, nothing is created and that card is returned with created:false; create cards for the remaining items in a separate call. Pass the same requestId when you retry a call so it returns the card it already created (created:false). At most 30 cards per session per hour (INTAKE_RATE_LIMITED). It does not start any work on the card; tell the user the card exists. Pass start to also start the card's first work session (optional start.prompt for the first message, optional start.model {provider, model, thinking, mode}); without start only the card is created. A session starts only when the card has no live session; otherwise the live session is returned with started:false, also for a card returned with created:false. Without start.model the project default model is used, then the host default model; if neither exists the session fails with MODEL_REQUIRED. A failed start never undoes the card: the call still succeeds with created:true and session:{error:{code,message}}, so do not retry the creation; tell the user and name the error. Returns {card:{id,title,status,projectId,workspaceId}, created, session?:{agentId,started}|{error:{code,message}}}. Returns INTAKE_DISABLED when the user has not turned on Agent intake in Flowly settings.";

const readOnlyAnnotations = { readOnlyHint: true, openWorldHint: false };
const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

async function enabledIntake(intake: IntakeTools | undefined) {
  if (!intake) throw new ToolError("TOOLS_UNAVAILABLE", "Agent intake is not available in this Flowly build.", true);
  if (!(await intake.isEnabled())) throw new ToolError("INTAKE_DISABLED", intakeDisabledMessage);
  return intake;
}

export function createIntakeMcpServer(options: {
  identity: IntakeIdentity;
  intake: () => IntakeTools | undefined;
  paseo: () => PaseoApi | undefined;
}) {
  const mcp = new McpServer({ name: "flowly-intake", version: "0.1.0" });
  mcp.registerTool(
    "flowly_intake_projects",
    { description: projectsDescription, inputSchema: intakeProjectsInputSchema, outputSchema: intakeProjectsResultSchema, annotations: readOnlyAnnotations },
    () => toolResult(async () => (await enabledIntake(options.intake())).projects()),
  );
  mcp.registerTool(
    "flowly_intake_create_card",
    { description: createDescription, inputSchema: intakeCreateInputSchema, outputSchema: intakeCreateResultSchema, annotations: createAnnotations },
    (input) =>
      toolResult(async () => {
        const intake = await enabledIntake(options.intake());
        const paseo = options.paseo();
        if (!paseo)
          throw new ToolError("PASEO_UNAVAILABLE", "Paseo context is not ready after startup or reload. Try again after the next session turn.", true);
        return intake.createCard(options.identity, input, paseo);
      }),
  );
  return mcp;
}
