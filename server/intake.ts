import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { enabledStatuses, laneName, laneProblem } from "../shared/lanes";
import type { Board, Project, Task } from "../shared/model";
import { taskInput } from "../shared/model";
import {
  candidateConnections,
  intakeCreateInputSchema,
  intakeLimits,
  type IntakeCandidate,
  type IntakeCreateInput,
  type IntakeCreateResult,
  type IntakeIdentity,
  type IntakeProjectsResult,
  type IntakeStart,
} from "../shared/intake";
import type { Connection } from "../shared/connectors";
import type { BoardStore } from "./store";
import { BoardService, resolveWorktreeBaseRef } from "./service";
import { refKey, type ConnectorService } from "./connectors/service";
import { ToolError, toolFailure } from "./tool-error";

export const intakeDisabledMessage = "Agent intake is off. The user can turn it on in Flowly settings, AI features, Agent intake.";
const intakeOperationPrefix = "intake:";
const defaultStatus = "todo";

export type IntakeTools = Pick<IntakeService, "isEnabled" | "projects" | "createCard">;

export type StartInput = { taskId: string; operationId: string; prompt?: string; model?: IntakeStart["model"] };

export type IntakeDependencies = {
  startSession: (input: StartInput, paseo: PaseoApi) => Promise<{ agentId: string; started: boolean }>;
  store: BoardStore;
  service: BoardService;
  connectors: Pick<ConnectorService, "list" | "resolve">;
  enabled: () => Promise<boolean>;
  clock?: () => number;
};

const cardOf = (task: Task) => ({ id: task.id, title: task.title, status: task.status, projectId: task.projectId, workspaceId: task.workspaceId });

const describeCandidate = ({ connection }: IntakeCandidate) => `${connection.id} (${connection.provider}, ${connection.name})`;

function connectionFor(item: string, connections: readonly Connection[], connectionId: string | undefined): IntakeCandidate {
  const pool = connectionId ? connections.filter((c) => c.id === connectionId) : connections;
  const candidates = candidateConnections(item, pool);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1)
    throw new ToolError("INTAKE_AMBIGUOUS_CONNECTION", `Several connections can read "${item}": ${candidates.map(describeCandidate).join(", ")}. Retry with connectionId set to one of these ids.`);
  throw new ToolError(
    "INTAKE_NO_CONNECTION",
    connectionId
      ? `Connection ${connectionId} does not exist or cannot read "${item}".`
      : `No connection can read "${item}". Use a Jira key, group/repo#12, group/repo!7 or an item URL of a connected service (flowly_intake_projects lists the connections).`,
  );
}

function operationIdOf(identity: IntakeIdentity, input: IntakeCreateInput, matches: readonly IntakeCandidate[]) {
  const refs = [...new Set(matches.map((m) => `${m.connection.id}:${m.key}`))].sort();
  const basis = [identity.agentId, input.projectId, refs, input.requestId ?? null];
  return intakeOperationPrefix + createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

function currentOperation(board: Board, baseOperationId: string) {
  for (let generation = 0; ; generation++) {
    const operationId = generation ? `${baseOperationId}:${generation}` : baseOperationId;
    const task = board.tasks.find((t) => t.operationId === operationId);
    if (!task || !task.archivedAt) return { operationId, task };
  }
}

export class IntakeService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly dependencies: IntakeDependencies) {}

  async isEnabled() {
    return this.dependencies.enabled().catch(() => false);
  }

  private async assertEnabled() {
    if (!(await this.isEnabled())) throw new ToolError("INTAKE_DISABLED", intakeDisabledMessage);
  }

  private serialized<T>(job: () => Promise<T>) {
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async worktreeOf(project: Project) {
    if (project.links) return { available: false };
    const defaultBaseRef = await resolveWorktreeBaseRef(project.primaryPath, "").catch(() => null);
    return defaultBaseRef ? { available: true, defaultBaseRef } : { available: false };
  }

  async projects(): Promise<IntakeProjectsResult> {
    await this.assertEnabled();
    const [board, connections] = await Promise.all([this.dependencies.store.read(), this.dependencies.connectors.list()]);
    const usable = connections.map(({ id, provider, name }) => ({ id, provider, label: name }));
    const live = board.projects.filter((p) => !p.archivedAt);
    return {
      projects: await Promise.all(
        live.map(async (project) => ({
          id: project.id,
          title: project.title,
          primaryPath: project.primaryPath,
          statuses: enabledStatuses(project).map((status) => ({ status, name: laneName(project, status) })),
          worktree: await this.worktreeOf(project),
          connections: usable,
        })),
      ),
    };
  }

  createCard(identity: IntakeIdentity, raw: unknown, paseo: PaseoApi): Promise<IntakeCreateResult> {
    return this.createThenStart(identity, raw, paseo);
  }

  private async createThenStart(identity: IntakeIdentity, raw: unknown, paseo: PaseoApi): Promise<IntakeCreateResult> {
    await this.assertEnabled();
    const input = intakeCreateInputSchema.parse(raw);
    const { task, created } = await this.serialized(() => this.create(identity, input, paseo));
    const card = cardOf(task);
    if (!input.start) return { card, created };
    return { card, created, session: await this.startSession(task, input.start, paseo) };
  }

  private async startSession(task: Task, start: IntakeStart, paseo: PaseoApi) {
    try {
      return await this.dependencies.startSession(
        { taskId: task.id, operationId: `${task.operationId}:session`, ...(start.prompt ? { prompt: start.prompt } : {}), ...(start.model ? { model: start.model } : {}) },
        paseo,
      );
    } catch (error) {
      const { code, message } = toolFailure(error);
      return { error: { code, message } };
    }
  }

  private async create(identity: IntakeIdentity, input: IntakeCreateInput, paseo: PaseoApi): Promise<{ task: Task; created: boolean }> {
    const { store, service, connectors } = this.dependencies;
    const board = await store.read();
    const project = board.projects.find((p) => p.id === input.projectId);
    if (!project || project.archivedAt) throw new ToolError("RESOURCE_UNAVAILABLE", "Project is unavailable or archived.");
    const status = input.status ?? defaultStatus;
    const laneError = laneProblem(project, status);
    if (laneError) throw new ToolError("INVALID_STATUS", laneError);
    const mode = input.mode ?? "directory";
    if (mode === "worktree" && !(await this.worktreeOf(project)).available)
      throw new ToolError("INVALID_INPUT", "Worktree mode is not available in this project; use mode directory.");
    const connections = await connectors.list();
    const matches = input.items.map((item) => connectionFor(item, connections, input.connectionId));
    const { operationId, task: earlier } = currentOperation(board, operationIdOf(identity, input, matches));
    if (earlier) return { task: earlier, created: false };
    this.assertWithinRate(board, identity.agentId);
    const resolved = [];
    for (const match of matches) resolved.push(await connectors.resolve(match.connection.id, match.key, match.itemType));
    const duplicate = this.liveCardWithInput(board, project.id, resolved.map((r) => refKey(r.external)));
    if (duplicate) return { task: duplicate, created: false };
    const task = await service.createTask(
      taskInput.parse({
        projectId: project.id,
        operationId,
        title: input.title ?? resolved[0]!.title,
        description: input.description ?? "",
        status,
        priority: input.priority,
        type: input.type,
        tags: input.tags,
        mode,
        baseRef: input.baseRef ?? "",
        branchName: input.branchName,
        externals: resolved.map(({ external }) => ({ connectionId: external.connectionId, key: external.key, itemType: external.itemType })),
      }),
      paseo,
      { actor: "agent", agentId: identity.agentId },
    );
    return { task, created: true };
  }

  private liveCardWithInput(board: Board, projectId: string, refs: readonly string[]) {
    const wanted = new Set(refs);
    for (const artifact of board.artifacts) {
      if (artifact.role !== "input" || !artifact.external || !wanted.has(refKey(artifact.external))) continue;
      const task = board.tasks.find((t) => t.id === artifact.taskId);
      if (task && task.projectId === projectId && !task.archivedAt) return task;
    }
    return undefined;
  }

  private assertWithinRate(board: Board, agentId: string) {
    const since = (this.dependencies.clock ?? Date.now)() - intakeLimits.hourMs;
    const recent = board.events.filter((e) => e.action === "created" && e.actor === "agent" && e.agentId === agentId && Date.parse(e.at) > since);
    if (recent.length >= intakeLimits.cardsPerHour)
      throw new ToolError("INTAKE_RATE_LIMITED", `At most ${intakeLimits.cardsPerHour} cards per hour per session. Try again later.`, true);
  }
}
