import { z } from "zod";
import {
  connectorLimits,
  connectorProviderSchema,
  parseKey,
  recognizeUrl,
  type Connection,
  type ItemType,
} from "./connectors";
import { prioritySchema, statusSchema, tagInputList, taskTypeSchema } from "./model";

export const intakeLimits = { cardsPerHour: 30, requestId: 100, hourMs: 60 * 60 * 1000 } as const;

export const intakeIdentitySchema = z.strictObject({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
});
export type IntakeIdentity = z.infer<typeof intakeIdentitySchema>;

export const intakeProjectsInputSchema = z.strictObject({});

export const intakeCreateInputSchema = z.strictObject({
  projectId: z.string().min(1).describe("Project id from flowly_intake_projects."),
  items: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(connectorLimits.perCreate)
    .describe("Tracker items to attach as the card's inputs: item keys (PROJ-12, group/repo#12, group/repo!7) or item URLs."),
  connectionId: z.string().min(1).optional().describe("Connection id from flowly_intake_projects; use it when an item fits several connections."),
  title: z.string().trim().min(1).max(200).optional().describe("Card title; default: the first item's title."),
  description: z.string().max(20000).optional().describe("Card description; default empty."),
  status: statusSchema.optional().describe("Lane to create the card in; default todo. Must be one of the project's statuses."),
  priority: prioritySchema.optional(),
  type: taskTypeSchema.optional(),
  tags: tagInputList.optional(),
  mode: z.enum(["directory", "worktree"]).optional().describe("directory (default) uses the project root; worktree makes an isolated branch where the project allows it."),
  branchName: z.string().trim().min(1).max(200).optional().describe("Worktree mode only."),
  baseRef: z.string().trim().min(1).max(200).optional().describe("Worktree mode only; default: the project's current branch."),
  requestId: z.string().trim().min(1).max(intakeLimits.requestId).optional().describe("Retry token: the same requestId from the same session returns the card it created."),
});
export type IntakeCreateInput = z.infer<typeof intakeCreateInputSchema>;

const intakeConnectionSchema = z.object({ id: z.string(), provider: connectorProviderSchema, label: z.string() });
export const intakeProjectsResultSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      primaryPath: z.string(),
      statuses: z.array(z.object({ status: statusSchema, name: z.string() })),
      worktree: z.object({ available: z.boolean(), defaultBaseRef: z.string().optional() }),
      connections: z.array(intakeConnectionSchema),
    }),
  ),
});
export type IntakeProjectsResult = z.infer<typeof intakeProjectsResultSchema>;

export const intakeCreateResultSchema = z.object({
  card: z.object({ id: z.string(), title: z.string(), status: statusSchema, projectId: z.string(), workspaceId: z.string() }),
  created: z.boolean(),
});
export type IntakeCreateResult = z.infer<typeof intakeCreateResultSchema>;

export type IntakeCandidate = { connection: Pick<Connection, "id" | "provider" | "baseUrl" | "name">; itemType: ItemType; key: string };

const isUrl = (item: string) => /^[a-z]+:\/\//i.test(item.trim());

function candidateFor(item: string, connection: IntakeCandidate["connection"]): IntakeCandidate | null {
  const found = isUrl(item) ? recognizeUrl(item, connection) : parseKey(item, connection.provider);
  return found && "key" in found ? { connection, itemType: found.itemType, key: found.key } : null;
}

export function candidateConnections(item: string, connections: readonly IntakeCandidate["connection"][]): IntakeCandidate[] {
  return connections.flatMap((connection) => {
    const candidate = candidateFor(item, connection);
    return candidate ? [candidate] : [];
  });
}
