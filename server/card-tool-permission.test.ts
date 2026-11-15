import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { cardToolNames } from "../shared/card-tools";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { allowOwnCardTool, isOwnCardToolRequest } from "./card-tool-permission";

const request = (name: string, kind = "tool") => ({ id: "req-1", provider: "claude", name, kind }) as AgentPermissionRequest;

test("every card tool on the flowly server is allowed", () => {
  for (const tool of cardToolNames) expect(isOwnCardToolRequest(request(`mcp__flowly__${tool}`)), tool).toBe(true);
});

test("the intake tools and unknown tools on the flowly server are refused", () => {
  expect(isOwnCardToolRequest(request("mcp__flowly-intake__flowly_intake_create_card"))).toBe(false);
  expect(isOwnCardToolRequest(request("mcp__flowly__flowly_intake_create_card"))).toBe(false);
  expect(isOwnCardToolRequest(request("mcp__flowly__flowly_delete_everything"))).toBe(false);
});

test("lookalike server names and tool names are refused", () => {
  for (const name of [
    "mcp__flowly_evil__flowly_get_task",
    "mcp__flowlyx__flowly_get_task",
    "mcp__xflowly__flowly_get_task",
    "mcp__flowly__flowly_get_task_x",
    "mcp__flowly__flowly_get_task__extra",
    "mcp__flowly__ flowly_get_task",
    "MCP__FLOWLY__FLOWLY_GET_TASK",
    "flowly_get_task",
    "mcp__flowly__",
    "",
  ])
    expect(isOwnCardToolRequest(request(name)), name).toBe(false);
});

test("other servers, shell, edits and the paseo tools are refused", () => {
  for (const name of ["mcp__paseo__create_agent", "mcp__other__flowly_get_task", "Bash", "Edit", "Write", "Read"])
    expect(isOwnCardToolRequest(request(name)), name).toBe(false);
});

test("questions, plans and mode changes are refused even under a card tool name", () => {
  for (const kind of ["question", "plan", "mode", "other"]) expect(isOwnCardToolRequest(request("mcp__flowly__flowly_get_task", kind)), kind).toBe(false);
});

function fakePaseo(respond = vi.fn(async (options: unknown) => undefined)) {
  const ref = vi.fn(() => ({ respondToPermission: respond }));
  return { paseo: { agents: { ref } } as unknown as PaseoApi, ref, respond };
}

test("an own card tool request is answered allow on the requesting agent", async () => {
  const x = fakePaseo();
  expect(await allowOwnCardTool(x.paseo, "agent-1", request("mcp__flowly__flowly_get_task"))).toBe(true);
  expect(x.ref).toHaveBeenCalledWith("agent-1");
  expect(x.respond).toHaveBeenCalledWith({ requestId: "req-1", response: { behavior: "allow" } });
});

test("any other request is left pending without touching the agent", async () => {
  const x = fakePaseo();
  expect(await allowOwnCardTool(x.paseo, "agent-1", request("Bash"))).toBe(false);
  expect(x.ref).not.toHaveBeenCalled();
});

test("a failed answer is logged, never thrown, and leaves the request pending", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = fakePaseo(vi.fn(async () => { throw new Error("already resolved"); }));
  await expect(allowOwnCardTool(x.paseo, "agent-1", request("mcp__flowly__flowly_get_task"))).resolves.toBe(false);
  expect(error).toHaveBeenCalledWith("Flowly card tool request not approved:", "agent-1", "already resolved");
  error.mockRestore();
});
