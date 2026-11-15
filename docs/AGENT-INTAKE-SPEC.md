# Agent intake: any Paseo session creates cards from tracker items

Status: designed and implemented on the user's request (2026-11-14): "create Flowly cards for Jira PROJ-12 and GitLab group/repo#45", said to any Paseo agent.

Read with [CONNECTORS-SPEC](CONNECTORS-SPEC.md) (connections, item keys), [EXTERNAL-TRACKER-SPEC](EXTERNAL-TRACKER-SPEC.md) (external inputs), [PASEO-SESSION-TOOLS-SPEC](PASEO-SESSION-TOOLS-SPEC.md) (the `flowly` MCP server and the session-open hook) and [SINGLE-ROOT-SPEC](SINGLE-ROOT-SPEC.md) (one project, one root, one card, one workspace).

## 1. Scope

- A second MCP server, `flowly-intake`, on the existing loopback tool server. Interactive Paseo sessions that are not card sessions get it at launch when the host setting **Agent intake** is on (off by default).
- Two tools: `flowly_intake_projects` (read-only) and `flowly_intake_create_card`.
- Card creation goes through the same `BoardService.createTask` the New task dialog uses. There is no second creation path.
- Optional: the create tool can also start the card's first work session (§5.6).
- Out of scope: reading or writing tracker items, editing or moving cards, creating projects.
- Card agents never create cards. A card session keeps only its card tools and never receives the intake server or an intake credential.

## 2. Setting

Host-scoped setting `agent-intake` (`agentIntakeSettings` in `shared/settings.ts`): `{ enabled: boolean }`, default `false`. Unreadable or invalid stored values read as `false`.

UI: Settings, AI features, group **Agent intake**, one switch **Agents can create cards** with a one-line detail, because the switch has a side effect: any Paseo session can then create cards. Every string is in all nine catalogs.

Turning the setting off applies at once to calls (§6). Sessions already open keep the server entry until their next launch, and every call they make is refused with `INTAKE_DISABLED`.

## 3. Credential and endpoint

- Path `/intake` on the tool server, MCP over HTTP, server name `flowly-intake`.
- Credential: `ToolSecrets.intakeCredential(identity)` seals `{ agentId, workspaceId }` with purpose `intake` (the purposes `session` and `write` are the card tools'). `workspaceId` is `null` when the session has none.
- `/intake` accepts only intake credentials. `/mcp` and `/api` accept only card credentials. A token of the other kind fails the signature purpose check and returns HTTP 401 with `UNAUTHORIZED`.
- Injection: in the `agent.open.before` hook, when `purpose` is `interactive`, `tools.sessionLaunch` returned nothing (not a managed card session), the session is not a Flowly helper session (`isSummarizer(request)`: summarizer, review and insight sessions), its workspace is not bound to any card, archived or not (`ToolServer.intakeLaunch`), its provider is `claude` or `codex` and the setting is on, add `mcpServers["flowly-intake"] = { type: "http", url, headers: { Authorization: "Bearer <intake token>" } }`. The entry exists at launch only, never in the saved agent config. The hook never throws; a failure is logged and the session opens without the server.
- The provider list exists because Paseo refuses to open a session whose provider takes no MCP servers, and the hook cannot read provider capabilities (PASEO-SESSION-TOOLS-SPEC §4.3). Other providers get no intake server until they are added to `providersAcceptingLaunchMcp` in `server/session-open.ts`.
- Only the session's own `agentId` is bound. The token never carries a card, and it grants no card tool.

## 4. Tool `flowly_intake_projects`

Input: `{}`. Read-only. Output:

```
{ projects: [{
    id, title, primaryPath,
    statuses: [{ status, name }],
    worktree: { available: boolean, defaultBaseRef?: string },
    connections: [{ id, provider, label }]
}] }
```

- `projects`: projects that are not archived, in board order.
- `statuses`: the project's enabled lanes (`enabledStatuses`), with the lane name the user sees. A card may be created in any of them (`laneProblem`).
- `worktree.available`: the project has no linked root (`project.links`) and its root has a named current branch; `defaultBaseRef` is that branch.
- `connections`: every saved connection. Connections are one host-wide store and any project may use any connection (README, "Connector tokens": isolation between projects is not a security boundary), so each project lists all of them. `label` is the connection's name. Credentials, emails and base URLs are never returned.

## 5. Tool `flowly_intake_create_card`

Input (strict):

| field | type | rule |
| --- | --- | --- |
| `projectId` | string | an existing, non-archived project |
| `items` | string[] | 1 to `connectorLimits.perCreate` (5): item keys (`PROJ-12`, `group/repo#12`, `group/repo!7`) or item URLs |
| `connectionId` | string, optional | use this connection for every item |
| `title` | string, optional | 1 to 200 characters; default: the first item's title |
| `description` | string, optional | up to 20000 characters; default empty |
| `status` | status, optional | default `todo`; must be an enabled lane |
| `priority`, `type`, `tags` | optional | as in the New task dialog |
| `mode` | `directory` or `worktree`, optional | default `directory`; `worktree` only when `worktree.available` |
| `branchName`, `baseRef` | string, optional | worktree mode only |
| `start` | object, optional | `{ prompt?: string (1 to 4000), model?: { provider, model, thinking?, mode? } }`; absent means no session (§5.6) |
| `requestId` | string, optional | 1 to 100 characters; idempotency (§5.3) |

Output: `{ card: { id, title, status, projectId, workspaceId }, created: boolean, session?: { agentId, started } | { error: { code, message } } }`. `session` is present only when `start` was given.

### 5.1 Resolving items to connections

Per item, in order:

1. With `connectionId`: that connection is the only candidate. An unknown id, or an item the connection's provider cannot parse, is `INTAKE_NO_CONNECTION`.
2. Without it: the candidates are all connections that can read the item. A URL matches when the connection recognizes it (`recognizeUrl`: same host and path below its base URL). A bare key matches when the provider parses it (`parseKey`).
3. Exactly one candidate: use it. None: `INTAKE_NO_CONNECTION`. Several: `INTAKE_AMBIGUOUS_CONNECTION`, the message names each candidate id with its provider and label so the agent can retry with `connectionId`.

Each item is then read from its service before any workspace exists (`ConnectorService.resolve`, the path of the New task dialog); an item that cannot be read refuses the card.

### 5.2 Duplicates

When any item's resolved reference (`refKey`: connection id, item type, key) is already an input artifact of a non-archived card in the same project, nothing is created and that card is returned with `created: false`. Remaining items need a separate call.

### 5.3 Idempotency

The `operationId` is `intake:` plus a SHA-256 digest of `agentId`, `projectId`, the sorted `connectionId:key` list and `requestId` (null when absent). A call whose operation already has a live card returns that card with `created: false`, before any item is read. When the operation's card is archived, the call uses the next generation (`<operationId>:1`, `:2`, ...) and creates a new card, so archiving a card never blocks the agent from creating it again. A reused `requestId` with other items or another project is another operation.

### 5.4 Rate guard

At most `intakeLimits.cardsPerHour` (30) cards per `agentId` in a rolling hour, counted from `created` events with actor `agent` and that `agentId`. The 31st call returns `INTAKE_RATE_LIMITED` and creates nothing. A constant, not a setting. The check runs before any item is read from a tracker, after the replay lookup, so a limited agent causes no tracker requests and still gets answers for replays of its own operations. Duplicates do not count.

### 5.5 Attribution

`createTask` takes an author: the dialog passes `human` (the default); intake passes `agent` with the `agentId`.

- The `created` event has actor `agent` and `agentId`.
- Each external input artifact has `createdBy: "agent"` and `agentId`, and its `artifact_added` event has actor `agent`.
- The card's tags and every other field keep their existing meaning.

Readers of these fields, checked:

| reader | effect |
| --- | --- |
| `contextLine` (`shared/artifacts.ts`) | the input shows as `[agent]` with its `flowly_read_external` hint; the skill says every external input is a requirement whoever added it |
| `get_task` `unread` (`server/agent-service.ts`) | the card's agents did not write it, so it is unread until they read it |
| drawer and activity (`client/drawer.tsx`, `client/task-artifacts.tsx`) | shown as added by an agent; the activity row names the actor "Agent" because the intake session is not in the card's workspace |
| telemetry `c_cards_created` | counts every `created` event; `c_user_actions` counts only human actors, so intake cards add no user action |
| agent habits, progress rules, auto review, insights | key on turn events of the card's own sessions (`agent.turn_started`, `status_changed`, `progress_reported`); the intake session's `created` and `artifact_added` events start no turn and match none of their rules |
| `dropArtifact` | an agent may remove agent-added artifacts, but not an external input another session attached (`artifact.agentId` differs): the call fails with `ARTIFACT_FORBIDDEN`; the skill says the same |

### 5.6 Starting the first session

With `start`, after the card is written (or found, for `created: false`), the tool calls `startCardSession` (`server/card-session-start.ts`) with the card's id, an operation id of `<card operationId>:session`, the prompt and the model.

- Model order: `start.model`, the project's default model, the host default model (Settings, Models). None: `MODEL_REQUIRED`.
- A card that already has a live session in its workspace gets no new one: the call returns that session's `agentId` with `started: false`. This covers replays and deduped cards.
- The session start runs outside the creation lock: only the check-and-create step is serialized, so a slow Paseo agent creation never blocks another agent's intake call.
- The session operation id derives from the card's, so a retried call never starts a second session.
- Creation and start are two steps. When the start fails, the call still succeeds with `created` as it was and `session: { error: { code, message } }`, so the agent does not retry the creation. Codes: `RESOURCE_UNAVAILABLE`, `ARCHIVED`, `TASK_FINISHED`, `MODEL_REQUIRED`, `SERVICE_FAILURE`.
- Invalid `start` input (for example a model without `model`) is refused before the card is created.

## 6. Errors

All errors use the tool result shape `{ code, message, retryable }`.

| code | when |
| --- | --- |
| `UNAUTHORIZED` | missing, malformed or other-purpose credential (HTTP 401) |
| `INTAKE_DISABLED` | the setting is off; every tool call is refused |
| `INTAKE_NO_CONNECTION` | no connection can read an item, or `connectionId` does not fit |
| `INTAKE_AMBIGUOUS_CONNECTION` | several connections can read an item |
| `INTAKE_RATE_LIMITED` | 30 cards in the last hour for this agent |
| `INVALID_INPUT` | schema violation, worktree mode on a project that has none |
| `INVALID_STATUS` | the status is not an enabled lane |
| `RESOURCE_UNAVAILABLE` | the project does not exist or is archived |
| `PASEO_UNAVAILABLE` | the Paseo context is not ready (retryable) |
| `EXTERNAL_*` | an item cannot be read (not found, auth, unavailable), as for card tools |

## 7. Descriptions

Intake sessions do not receive `SKILL.md`, so each tool description states what it does, its inputs, the duplicate and idempotency rules and its error codes in English.

## 8. Acceptance criteria

1. Setting off: `flowly_intake_projects` and `flowly_intake_create_card` return `INTAKE_DISABLED`; the hook adds no server.
2. Setting on: an interactive, non-card, non-helper session on provider `claude` or `codex` gets `flowly-intake`; a card session, a history open, a helper session and other providers do not.
3. A card token on `/intake` and an intake token on `/mcp` and `/api` return 401.
4. `flowly_intake_projects` lists only live projects with enabled lanes, worktree availability and all connections.
5. Creating with one item makes one card with that input attached, workspace created, `created: true`, actor `agent` on the event and artifact.
6. A second item set that matches an existing live card returns it with `created: false` and creates nothing.
7. A key two connections can parse returns `INTAKE_AMBIGUOUS_CONNECTION`; `connectionId` resolves it; an unparsable item returns `INTAKE_NO_CONNECTION`.
8. The same `requestId` from the same agent returns the same card; another agent gets its own.
9. The 31st creation in an hour returns `INTAKE_RATE_LIMITED`.
10. A status that is not a lane, 0 items and 6 items are refused.
11. Without `start` no session is started. With `start`: the default model is used when `model` is omitted, an explicit model is passed on, `MODEL_REQUIRED` returns the created card with a session error, a replay or a deduped card returns the live session with `started: false` or starts the missing one once.
12. `npm run typecheck` and `npm test` pass, including the catalog checks.

## 9. Known limits

- Duplicate detection and the New task dialog are not atomic: a card created in the dialog between an intake call's duplicate check and its write can produce two cards for one item.
- The rate guard counts `created` events, so deleting a card removes its count.
