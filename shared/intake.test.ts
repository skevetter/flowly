import { expect, test } from "vitest";
import { candidateConnections, intakeCreateInputSchema, type IntakeCandidate } from "./intake";
import { connectorLimits } from "./connectors";

const jira: IntakeCandidate["connection"] = { id: "jira", provider: "jira-cloud", baseUrl: "https://example.atlassian.net", name: "Work Jira" };
const gitlab: IntakeCandidate["connection"] = { id: "gitlab", provider: "gitlab", baseUrl: "https://gitlab.example.com", name: "Team GitLab" };
const github: IntakeCandidate["connection"] = { id: "github", provider: "github", baseUrl: "https://github.com", name: "GitHub" };

test("no connections means no candidates", () => {
  expect(candidateConnections("PROJ-12", [])).toEqual([]);
});

test("a Jira key matches the Jira connection only", () => {
  expect(candidateConnections("PROJ-12", [jira, gitlab, github])).toEqual([{ connection: jira, itemType: "issue", key: "PROJ-12" }]);
});

test("a repo reference matches every connection of a provider that parses it", () => {
  expect(candidateConnections("group/repo#12", [jira, gitlab, github]).map((c) => c.connection.id)).toEqual(["gitlab", "github"]);
});

test("a merge request reference matches GitLab only", () => {
  expect(candidateConnections("group/repo!7", [gitlab, github])).toEqual([{ connection: gitlab, itemType: "merge_request", key: "group/repo!7" }]);
});

test("an item URL matches only the connection whose host it is on", () => {
  const url = "https://gitlab.example.com/group/repo/-/issues/45";
  expect(candidateConnections(url, [gitlab, github, jira])).toEqual([{ connection: gitlab, itemType: "issue", key: "group/repo#45" }]);
  expect(candidateConnections("https://elsewhere.example.org/group/repo/-/issues/45", [gitlab])).toEqual([]);
});

test("a bare key is never taken for a URL and text that is neither matches nothing", () => {
  expect(candidateConnections("fix the login page", [jira, gitlab, github])).toEqual([]);
});

test("a link that needs a title lookup has no key and matches nothing", () => {
  const confluence: IntakeCandidate["connection"] = { id: "wiki", provider: "confluence-cloud", baseUrl: "https://example.atlassian.net/wiki", name: "Wiki" };
  expect(candidateConnections("https://example.atlassian.net/wiki/display/DOC/Some+Page", [confluence])).toEqual([]);
});

test("items are limited to the connector creation limit and need at least one", () => {
  const base = { projectId: "p" };
  expect(intakeCreateInputSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  expect(intakeCreateInputSchema.safeParse({ ...base, items: ["A-1"] }).success).toBe(true);
  const atLimit = Array.from({ length: connectorLimits.perCreate }, (_, i) => `A-${i + 1}`);
  expect(intakeCreateInputSchema.safeParse({ ...base, items: atLimit }).success).toBe(true);
  expect(intakeCreateInputSchema.safeParse({ ...base, items: [...atLimit, "A-99"] }).success).toBe(false);
});

test("unknown fields are refused", () => {
  expect(intakeCreateInputSchema.safeParse({ projectId: "p", items: ["A-1"], operationId: "x" }).success).toBe(false);
});
