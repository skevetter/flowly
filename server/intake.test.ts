import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ConnectorService } from "./connectors/service";
import { fakeService, type Route } from "./connectors/fake";
import { IntakeService } from "./intake";
import { intakeLimits } from "../shared/intake";
import { projectLanes } from "../shared/lanes";

const git = promisify(execFile),
  roots: string[] = [],
  services: ConnectorService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.flush()));
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const issues: Record<string, string> = { "AB-1": "Empty result page", "AB-2": "Slow login", "CD-3": "Broken export" };
const jiraIssue = (key: string) => ({
  id: String(10000 + Number(key.split("-")[1])),
  key,
  fields: {
    summary: issues[key],
    status: { name: "Open", statusCategory: { key: "new" } },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { displayName: "Ada" },
    updated: "2026-10-18T10:00:00.000+0800",
    description: "Steps",
    comment: { comments: [], total: 0 },
  },
});
const gitlabIssue = (repo: string, iid: number) => ({
  id: 1000 + iid,
  iid,
  title: "Crash on start",
  description: "Steps",
  state: "opened",
  draft: false,
  labels: [],
  author: { name: "Ada", username: "ada" },
  assignees: [],
  reviewers: [],
  updated_at: "2026-10-19T08:00:00.000Z",
  web_url: `https://gitlab.example.com/${repo}/-/issues/${iid}`,
});
const route: Route = (url) => {
  if (url.host === "gitlab.example.com") {
    const path = url.pathname.replace(/^\/api\/v4/, "");
    if (path === "/user") return { body: { name: "Ada Lovelace", username: "ada" } };
    const item = /^\/projects\/([^/]+)\/issues\/(\d+)(\/notes)?$/.exec(path);
    if (!item) return undefined;
    if (item[3]) return { body: [] };
    return decodeURIComponent(item[1]!) === "group/repo" ? { body: gitlabIssue("group/repo", Number(item[2])) } : undefined;
  }
  if (url.pathname.endsWith("/rest/api/2/myself")) return { body: { displayName: "Ada Lovelace" } };
  const one = /\/rest\/api\/2\/issue\/([A-Z0-9_]+-\d+)$/.exec(url.pathname);
  return one && issues[one[1]!] ? { body: jiraIssue(one[1]!) } : undefined;
};

type Setup = Awaited<ReturnType<typeof setup>>;
async function setup(options: { enabled?: boolean; secondJira?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-intake-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = new BoardStore(join(root, "data")),
    now = new Date().toISOString();
  await store.mutate((board) =>
    board.projects.push({ id: "p", paseoProjectId: "native", title: "Project", description: "", primaryPath: projectRoot, repos: [projectRoot], revision: 1, createdAt: now, updatedAt: now, archivedAt: null }),
  );
  const connectors = new ConnectorService(join(root, "connectors"), fakeService(route).fetchImpl);
  services.push(connectors);
  const jira = await connectors.save({ provider: "jira-dc", name: "Work Jira", baseUrl: "https://jira.example.com", secret: "jira-secret" }),
    gitlab = await connectors.save({ provider: "gitlab", name: "Team GitLab", baseUrl: "https://gitlab.example.com", secret: "gitlab-secret" }),
    secondJira = options.secondJira ? await connectors.save({ provider: "jira-dc", name: "Other Jira", baseUrl: "https://jira.example.com/other", secret: "other-secret" }) : null;
  const service = new BoardService(store);
  service.connectors = connectors;
  const create = vi.fn(async (...request: unknown[]) => ({ id: `workspace-${randomUUID()}` }));
  const paseo = { workspaces: { create, ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi;
  const flags = { enabled: options.enabled ?? true };
  const intake = new IntakeService({ store, service, connectors, enabled: async () => flags.enabled });
  const talker = { agentId: "talker", workspaceId: "w-talker" };
  return { root, projectRoot, store, service, connectors, jira, gitlab, secondJira, create, paseo, flags, intake, talker };
}
const cards = async (x: Setup) => (await x.store.read()).tasks;

test("no projects are listed when every project is archived", async () => {
  const x = await setup();
  await x.store.mutate((board) => void (board.projects[0]!.archivedAt = new Date().toISOString()));
  expect(await x.intake.projects()).toEqual({ projects: [] });
});

test("with the setting off both operations are refused", async () => {
  const x = await setup({ enabled: false });
  await expect(x.intake.projects()).rejects.toMatchObject({ code: "INTAKE_DISABLED" });
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo)).rejects.toMatchObject({ code: "INTAKE_DISABLED" });
  expect(await cards(x)).toHaveLength(0);
});

test("one Jira key makes one card in todo with the item as an input written by the agent", async () => {
  const x = await setup();
  const result = await x.intake.createCard(x.talker, { projectId: "p", items: ["ab-1"] }, x.paseo);
  expect(result).toEqual({
    card: { id: expect.any(String), title: "AB-1 Empty result page", status: "todo", projectId: "p", workspaceId: expect.stringMatching(/^workspace-/) },
    created: true,
  });
  const board = await x.store.read();
  expect(board.artifacts).toEqual([
    expect.objectContaining({ taskId: result.card.id, role: "input", createdBy: "agent", agentId: "talker", external: expect.objectContaining({ key: "AB-1", connectionId: x.jira.id }) }),
  ]);
  expect(board.events.filter((e) => e.taskId === result.card.id)).toEqual([
    expect.objectContaining({ action: "created", actor: "agent", agentId: "talker" }),
    expect.objectContaining({ action: "artifact_added", actor: "agent", agentId: "talker" }),
  ]);
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("items from two services become two inputs of one card with the first item's title", async () => {
  const x = await setup();
  const result = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1", "group/repo#45"] }, x.paseo);
  expect(result.card.title).toBe("AB-1 Empty result page");
  expect((await x.store.read()).artifacts.map((a) => a.external?.key).sort()).toEqual(["AB-1", "group/repo#45"]);
  expect(await cards(x)).toHaveLength(1);
});

test("explicit title, description, status, priority, type and tags are used", async () => {
  const x = await setup();
  const result = await x.intake.createCard(
    x.talker,
    { projectId: "p", items: ["AB-1"], title: "Investigate", description: "Why empty", status: "backlog", priority: "high", type: "bugfix", tags: ["search"] },
    x.paseo,
  );
  expect(result.card).toMatchObject({ title: "Investigate", status: "backlog" });
  expect((await cards(x))[0]).toMatchObject({ description: "Why empty", priority: "high", type: "bugfix" });
});

test("projects list live projects with lane names, worktree availability and every connection without secrets", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects[0]!.lanes = projectLanes(null).map((lane) => (lane.status === "backlog" ? { ...lane, enabled: false } : lane.status === "todo" ? { ...lane, name: "Inbox" } : lane));
  });
  const { projects } = await x.intake.projects();
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({
    id: "p",
    title: "Project",
    primaryPath: x.projectRoot,
    worktree: { available: false },
    connections: [
      { id: x.jira.id, provider: "jira-dc", label: "Work Jira" },
      { id: x.gitlab.id, provider: "gitlab", label: "Team GitLab" },
    ],
  });
  expect(projects[0]!.statuses).toContainEqual({ status: "todo", name: "Inbox" });
  expect(projects[0]!.statuses.map((s) => s.status)).not.toContain("backlog");
  expect(JSON.stringify(projects)).not.toMatch(/secret|baseUrl|https:/);
});

test("worktree is available in a git project with the current branch as the default base", async () => {
  const x = await setup();
  await git("git", ["-C", x.projectRoot, "init", "-q", "-b", "main"]);
  expect((await x.intake.projects()).projects[0]!.worktree).toEqual({ available: true, defaultBaseRef: "refs/heads/main" });
});

test("worktree mode makes a worktree card and is refused in a project without a branch", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], mode: "worktree" }, x.paseo)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(x.create).not.toHaveBeenCalled();
  await git("git", ["-C", x.projectRoot, "init", "-q", "-b", "main"]);
  await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], mode: "worktree", branchName: "intake/ab-1" }, x.paseo);
  expect(x.create.mock.calls[0]![0]).toMatchObject({ source: { kind: "worktree", branchName: "intake/ab-1" } });
});

test("at most the creation limit of cards per hour per agent, counted over a rolling hour", async () => {
  const x = await setup();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  await x.store.mutate((board) => {
    for (let n = 0; n < intakeLimits.cardsPerHour; n++)
      board.events.push({ id: randomUUID(), taskId: `old-${n}`, actor: "agent", agentId: "talker", action: "created", at: minutesAgo(n === 0 ? 59 : 10) });
  });
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo)).rejects.toMatchObject({ code: "INTAKE_RATE_LIMITED" });
  expect(await cards(x)).toHaveLength(0);
  await expect(x.intake.createCard({ agentId: "other", workspaceId: null }, { projectId: "p", items: ["AB-1"] }, x.paseo)).resolves.toMatchObject({ created: true });
  await x.store.mutate((board) => void (board.events.find((e) => e.taskId === "old-0")!.at = minutesAgo(61)));
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-2"] }, x.paseo)).resolves.toMatchObject({ created: true });
});

test("an item already an input of a live card returns that card and creates nothing", async () => {
  const x = await setup();
  const first = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo);
  const again = await x.intake.createCard({ agentId: "another", workspaceId: null }, { projectId: "p", items: ["AB-2", "ab-1"] }, x.paseo);
  expect(again).toEqual({ card: first.card, created: false });
  expect(await cards(x)).toHaveLength(1);
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("an archived card does not block a new card for the same item", async () => {
  const x = await setup();
  const first = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo);
  await x.store.mutate((board) => void (board.tasks.find((t) => t.id === first.card.id)!.archivedAt = new Date().toISOString()));
  const again = await x.intake.createCard({ agentId: "another", workspaceId: null }, { projectId: "p", items: ["AB-1"] }, x.paseo);
  expect(again.created).toBe(true);
  expect(again.card.id).not.toBe(first.card.id);
});

test("the same request id from the same agent returns the same card, other agents get their own", async () => {
  const x = await setup();
  const first = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], requestId: "r1" }, x.paseo);
  const replay = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-2"], requestId: "r1" }, x.paseo);
  expect(replay).toEqual({ card: first.card, created: false });
  const other = await x.intake.createCard({ agentId: "other", workspaceId: null }, { projectId: "p", items: ["AB-2"], requestId: "r1" }, x.paseo);
  expect(other.created).toBe(true);
  expect(other.card.id).not.toBe(first.card.id);
});

test("without a request id the same agent repeating the same items gets the same card", async () => {
  const x = await setup();
  const first = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1", "AB-2"] }, x.paseo);
  await x.store.mutate((board) => void (board.artifacts = []));
  const replay = await x.intake.createCard(x.talker, { projectId: "p", items: ["ab-2", "AB-1"] }, x.paseo);
  expect(replay).toEqual({ card: first.card, created: false });
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("a key no connection can read is refused, naming the item", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["fix the login page"] }, x.paseo)).rejects.toMatchObject({
    code: "INTAKE_NO_CONNECTION",
    message: expect.stringContaining("fix the login page"),
  });
  expect(x.create).not.toHaveBeenCalled();
});

test("a key several connections can read is ambiguous until a connection is named", async () => {
  const x = await setup({ secondJira: true });
  const ambiguous = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo).catch((e) => e);
  expect(ambiguous).toMatchObject({ code: "INTAKE_AMBIGUOUS_CONNECTION" });
  expect(ambiguous.message).toContain(x.jira.id);
  expect(ambiguous.message).toContain(x.secondJira!.id);
  expect(x.create).not.toHaveBeenCalled();
  const named = await x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], connectionId: x.jira.id }, x.paseo);
  expect(named.created).toBe(true);
});

test("a link is matched to the connection on its host", async () => {
  const x = await setup({ secondJira: true });
  const result = await x.intake.createCard(x.talker, { projectId: "p", items: ["https://gitlab.example.com/group/repo/-/issues/45"] }, x.paseo);
  expect(result.created).toBe(true);
  expect((await x.store.read()).artifacts[0]!.external).toMatchObject({ connectionId: x.gitlab.id, key: "group/repo#45" });
});

test("a named connection that does not exist or cannot read the item is refused", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], connectionId: "missing" }, x.paseo)).rejects.toMatchObject({ code: "INTAKE_NO_CONNECTION" });
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], connectionId: x.gitlab.id }, x.paseo)).rejects.toMatchObject({ code: "INTAKE_NO_CONNECTION" });
});

test("an item the service does not have refuses the card before any workspace exists", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-404"] }, x.paseo)).rejects.toThrow(/not found/i);
  expect(x.create).not.toHaveBeenCalled();
  expect(await cards(x)).toHaveLength(0);
});

test("a status that is not a lane of the project is refused", async () => {
  const x = await setup();
  await x.store.mutate((board) => void (board.projects[0]!.lanes = projectLanes(null).map((lane) => (lane.status === "blocked" ? { ...lane, enabled: false } : lane))));
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"], status: "blocked" }, x.paseo)).rejects.toMatchObject({ code: "INVALID_STATUS" });
  expect(x.create).not.toHaveBeenCalled();
});

test("a missing or archived project is refused", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "nope", items: ["AB-1"] }, x.paseo)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  await x.store.mutate((board) => void (board.projects[0]!.archivedAt = new Date().toISOString()));
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: ["AB-1"] }, x.paseo)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
});

test("input outside the schema is refused", async () => {
  const x = await setup();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: [] }, x.paseo)).rejects.toThrow();
  await expect(x.intake.createCard(x.talker, { projectId: "p", items: Array(6).fill("AB-1") }, x.paseo)).rejects.toThrow();
});
