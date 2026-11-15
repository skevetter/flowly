import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { openKanbanSession } from "./session-open";

const paseo = {} as PaseoApi,
  mcp = { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } };
function request(overrides: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return {
    agentId: "a",
    workspaceId: "w",
    provider: "claude",
    cwd: "/tmp",
    reason: "resume",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [],
    env: { KEEP: "1" },
    mcpServers: { other: { type: "http", url: "http://other" } },
    ...overrides,
  };
}
const intakeMcp = { type: "http" as const, url: "http://127.0.0.1:1/intake", headers: { Authorization: "Bearer intake" } };
function tools(launch: () => Promise<{ contextFile: string; mcp: typeof mcp | null } | null>, intake: () => Promise<typeof intakeMcp | null> = async () => null) {
  return { attach: vi.fn(), sessionLaunch: vi.fn(launch), intakeLaunch: vi.fn(intake) };
}
afterEach(() => vi.restoreAllMocks());

test("a managed session gets its environment and, at launch, the flowly server beside other plugins' servers", async () => {
  const opened = await openKanbanSession(request(), tools(async () => ({ contextFile: "/d/sessions/a.json", mcp })), "/d", paseo);
  expect(opened?.env).toEqual({
    KEEP: "1",
    FLOWLY_CONTEXT_FILE: "/d/sessions/a.json",
    FLOWLY_CLI: "/d/flowly.mjs",
    FLOWLY_SKILL: "/d/SKILL.md",
  });
  expect(opened?.mcpServers).toEqual({ other: { type: "http", url: "http://other" }, flowly: mcp });
});
test("no MCP server when the launch withholds it; unmanaged and history opens pass through", async () => {
  const cliOnly = await openKanbanSession(request(), tools(async () => ({ contextFile: "/d/s.json", mcp: null })), "/d", paseo);
  expect(cliOnly?.mcpServers).toEqual({ other: { type: "http", url: "http://other" } });
  expect(await openKanbanSession(request(), tools(async () => null), "/d", paseo)).toBeUndefined();
  const history = tools(async () => ({ contextFile: "/d/s.json", mcp }));
  expect(await openKanbanSession(request({ purpose: "history" }), history, "/d", paseo)).toBeUndefined();
  expect(history.sessionLaunch).not.toHaveBeenCalled();
});
test("a failure is logged and never thrown, so the session still opens", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(
    openKanbanSession(request(), tools(async () => { throw new Error("disk"); }), "/d", paseo),
  ).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith("Kanban session tools unavailable:", "a", "disk");
});

test("an interactive session that is not a card session gets the intake server and no card environment", async () => {
  const t = tools(async () => null, async () => intakeMcp);
  const opened = await openKanbanSession(request(), t, "/d", paseo);
  expect(opened?.mcpServers).toEqual({ other: { type: "http", url: "http://other" }, "flowly-intake": intakeMcp });
  expect(opened?.env).toEqual({ KEEP: "1" });
  expect(t.intakeLaunch).toHaveBeenCalledWith("a", "w", paseo);
});
test("a session without a workspace still gets the intake server", async () => {
  const t = tools(async () => null, async () => intakeMcp);
  const opened = await openKanbanSession(request({ workspaceId: null }), t, "/d", paseo);
  expect(opened?.mcpServers).toHaveProperty("flowly-intake");
  expect(t.intakeLaunch).toHaveBeenCalledWith("a", null, paseo);
});
test("no intake server when the setting is off", async () => {
  expect(await openKanbanSession(request(), tools(async () => null, async () => null), "/d", paseo)).toBeUndefined();
});
test("a card session keeps only its card tools and never asks for intake", async () => {
  const t = tools(async () => ({ contextFile: "/d/sessions/a.json", mcp }), async () => intakeMcp);
  const opened = await openKanbanSession(request(), t, "/d", paseo);
  expect(Object.keys(opened!.mcpServers)).toEqual(["other", "flowly"]);
  expect(t.intakeLaunch).not.toHaveBeenCalled();
  const cliOnly = tools(async () => ({ contextFile: "/d/s.json", mcp: null }), async () => intakeMcp);
  expect(Object.keys((await openKanbanSession(request(), cliOnly, "/d", paseo))!.mcpServers)).toEqual(["other"]);
  expect(cliOnly.intakeLaunch).not.toHaveBeenCalled();
});
test("history opens and Flowly's own helper sessions never get the intake server", async () => {
  const history = tools(async () => null, async () => intakeMcp);
  expect(await openKanbanSession(request({ purpose: "history" }), history, "/d", paseo)).toBeUndefined();
  const helper = tools(async () => null, async () => intakeMcp);
  expect(await openKanbanSession(request({ labels: { flowly: "summarizer" } }), helper, "/d", paseo)).toBeUndefined();
  expect(history.intakeLaunch).not.toHaveBeenCalled();
  expect(helper.intakeLaunch).not.toHaveBeenCalled();
});
test("only providers known to accept launch MCP servers get the intake server", async () => {
  for (const provider of ["claude", "codex"]) {
    const t = tools(async () => null, async () => intakeMcp);
    expect(await openKanbanSession(request({ provider }), t, "/d", paseo), provider).toBeDefined();
  }
  const unsupported = tools(async () => null, async () => intakeMcp);
  expect(await openKanbanSession(request({ provider: "pi" }), unsupported, "/d", paseo)).toBeUndefined();
  expect(unsupported.intakeLaunch).not.toHaveBeenCalled();
});
test("an intake failure is logged and never thrown, so the session still opens", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(
    openKanbanSession(request(), tools(async () => null, async () => { throw new Error("port"); }), "/d", paseo),
  ).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith("Kanban session tools unavailable:", "a", "port");
});
