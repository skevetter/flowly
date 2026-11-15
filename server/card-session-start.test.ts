import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { ToolServer } from "./tool-server";
import { DEFAULT_FIRST_PROMPT, startCardSession } from "./card-session-start";
import type { AgentModel } from "../shared/agent-defaults";

type FakeAgent = { id: string; workspaceId: string; status: string; archivedAt: string | null; labels: Record<string, string> };
type CreateCall = { workspaceId: string; options: Record<string, any> };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

const hostModel: AgentModel = { provider: "claude", model: "host-model", thinking: "low", mode: "default" };
const explicitModel: AgentModel = { provider: "codex", model: "explicit-model" };

async function setup(options: { hostDefault?: AgentModel | null; liveAgents?: boolean; createFailsAfterRegistering?: boolean } = {}) {
  const { hostDefault = hostModel, liveAgents = false, createFailsAfterRegistering = false } = options;
  const fixture = await agentFixture();
  const tools = new ToolServer(fixture.store);
  cleanups.push(async () => {
    await tools.stop();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const agents = new Map<string, FakeAgent>();
  if (liveAgents)
    agents.set("existing", { id: "existing", workspaceId: "w", status: "idle", archivedAt: null, labels: {} });
  const creates: CreateCall[] = [];
  const paseo = {
    ...fixture.paseo,
    agents: {
      ref: (id: string) => ({ refresh: async () => (agents.has(id) ? { agent: agents.get(id) } : null) }),
      list: async () => ({
        entries: [...agents.values()].map((agent) => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => fixture.workspace(),
        agents: {
          create: async (createOptions: Record<string, any>) => {
            creates.push({ workspaceId, options: createOptions });
            agents.set(createOptions.agentId, {
              id: createOptions.agentId,
              workspaceId,
              status: "running",
              archivedAt: null,
              labels: createOptions.labels,
            });
            if (createFailsAfterRegistering) throw new Error("transport closed");
            return { id: createOptions.agentId };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const dependencies = { tools, paseo, hostModel: async () => hostDefault };
  const start = (input: Partial<Parameters<typeof startCardSession>[1]> = {}) =>
    startCardSession(dependencies, { taskId: "t", operationId: "op-1", ...input });
  const setTask = (change: { status?: "done" | "cancelled" | "todo"; archivedAt?: string }) =>
    fixture.store.mutate((board) => {
      Object.assign(board.tasks[0], change);
    });
  return { ...fixture, tools, paseo, agents, creates, start, setTask };
}

test("a card with no session starts one and reports started", async () => {
  const x = await setup();
  const result = await x.start();
  expect(result.started).toBe(true);
  expect(x.creates).toHaveLength(1);
  expect(x.creates[0].workspaceId).toBe("w");
  expect(result.agentId).toBe(x.creates[0].options.agentId);
});

test("the host model defaults apply when no model is given", async () => {
  const x = await setup();
  await x.start();
  expect(x.creates[0].options.config).toMatchObject({
    provider: "claude/host-model",
    modeId: "default",
    thinkingOptionId: "low",
  });
});

test("an explicit model overrides the host defaults", async () => {
  const x = await setup();
  await x.start({ model: explicitModel });
  expect(x.creates[0].options.config.provider).toBe("codex/explicit-model");
  expect(x.creates[0].options.config).not.toHaveProperty("modeId");
});

test("the project default model beats the host default", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects[0].agentModel = { provider: "codex", model: "project-model" };
  });
  await x.start();
  expect(x.creates[0].options.config.provider).toBe("codex/project-model");
});

test("no model anywhere fails with MODEL_REQUIRED and creates nothing", async () => {
  const x = await setup({ hostDefault: null });
  await expect(x.start()).rejects.toMatchObject({ code: "MODEL_REQUIRED" });
  expect(x.creates).toHaveLength(0);
});

test("the first prompt defaults to a named constant and a given prompt is trimmed", async () => {
  const x = await setup();
  await x.start();
  expect(x.creates[0].options.prompt).toBe(DEFAULT_FIRST_PROMPT);
  const y = await setup();
  await y.start({ prompt: "  Fix the bug.  " });
  expect(y.creates[0].options.prompt).toBe("Fix the bug.");
});

test("the prepared identity, system prompt, env, labels and title reach the agent", async () => {
  const x = await setup();
  const preparation = await x.tools.prepareSession("t", "op-1", x.paseo);
  const result = await x.start();
  const { options } = x.creates[0];
  expect(result.agentId).toBe(preparation.agentId);
  expect(options.agentId).toBe(preparation.agentId);
  expect(options.idempotencyKey).toBe(`ultra-kanban-session:${preparation.agentId}`);
  expect(options.config.systemPrompt).toBe(preparation.instructions);
  expect(options.env).toEqual({
    FLOWLY_CONTEXT_FILE: preparation.contextFile,
    FLOWLY_CLI: preparation.cliPath,
    FLOWLY_SKILL: preparation.skillPath,
  });
  expect(options.labels).toEqual({ "flowly-task": "t" });
  expect(options.title).toBe("Card");
});

test("a retry with the same operation returns the existing agent and sends no second prompt", async () => {
  const x = await setup();
  const first = await x.start();
  const second = await x.start();
  expect(second).toEqual({ agentId: first.agentId, started: false });
  expect(x.creates).toHaveLength(1);
});

test("a live session in the card workspace is returned without starting another", async () => {
  const x = await setup({ liveAgents: true });
  expect(await x.start()).toEqual({ agentId: "existing", started: false });
  expect(x.creates).toHaveLength(0);
});

test("archived and helper sessions do not count as live", async () => {
  const x = await setup();
  x.agents.set("old", { id: "old", workspaceId: "w", status: "idle", archivedAt: "2026-01-01T00:00:00Z", labels: {} });
  x.agents.set("helper", { id: "helper", workspaceId: "w", status: "idle", archivedAt: null, labels: { flowly: "summarizer" } });
  x.agents.set("elsewhere", { id: "elsewhere", workspaceId: "other", status: "idle", archivedAt: null, labels: {} });
  expect((await x.start()).started).toBe(true);
});

test("an archived card is refused with ARCHIVED", async () => {
  const x = await setup();
  await x.setTask({ archivedAt: "2026-01-01T00:00:00Z" });
  await expect(x.start()).rejects.toMatchObject({ code: "ARCHIVED" });
  expect(x.creates).toHaveLength(0);
});

test.each(["done", "cancelled"] as const)("a %s card is refused with TASK_FINISHED", async (status) => {
  const x = await setup();
  await x.setTask({ status });
  await expect(x.start()).rejects.toMatchObject({ code: "TASK_FINISHED" });
  expect(x.creates).toHaveLength(0);
});

test("an unknown card is refused with RESOURCE_UNAVAILABLE", async () => {
  const x = await setup();
  await expect(x.start({ taskId: "missing" })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
});

test("a create call that fails after the agent exists returns it as not started", async () => {
  const x = await setup({ createFailsAfterRegistering: true });
  const result = await x.start();
  expect(result.started).toBe(false);
  expect(x.agents.has(result.agentId)).toBe(true);
});

test("a create call that fails with no agent created rethrows", async () => {
  const x = await setup();
  (x.paseo.workspaces.ref as unknown) = () => ({
    refresh: async () => x.workspace(),
    agents: { create: async () => Promise.reject(new Error("provider unavailable")) },
  });
  await expect(x.start()).rejects.toThrow("provider unavailable");
});
