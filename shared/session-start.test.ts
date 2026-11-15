import { expect, test } from "vitest";
import { agentSessionConfig, preparedSessionLaunch } from "./session-start";

test("config joins provider and model and omits unset mode and thinking", () => {
  expect(agentSessionConfig({ provider: "claude", model: "m" }, "rules")).toEqual({
    provider: "claude/m",
    systemPrompt: "rules",
  });
});

test("config carries mode and thinking when set", () => {
  expect(agentSessionConfig({ provider: "claude", model: "m", mode: "plan", thinking: "high" }, "rules")).toEqual({
    provider: "claude/m",
    systemPrompt: "rules",
    modeId: "plan",
    thinkingOptionId: "high",
  });
});

test("launch binds the prepared agent id, idempotency key and context env", () => {
  const launch = preparedSessionLaunch({
    agentId: "a1",
    contextFile: "/ctx",
    cliPath: "/cli",
    skillPath: "/skill",
    instructions: "x",
  });
  expect(launch).toEqual({
    agentId: "a1",
    idempotencyKey: "ultra-kanban-session:a1",
    env: { FLOWLY_CONTEXT_FILE: "/ctx", FLOWLY_CLI: "/cli", FLOWLY_SKILL: "/skill" },
  });
});
