# Model calls: opt-in, daily cap, text cap

Every Flowly feature that runs a model sends text from the user's projects to the provider of the configured summary models: progress summaries, outside-session insights, the finished-card memory review, the daily digest and workflow insights (Skills). That text can include private project content (conversation excerpts, card titles, descriptions, summaries, commands).

## Contract

Host setting `task-summary` (version 1), additive fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `sendTextToModels` | `false` | Nothing is sent to any model until this is on, whatever the other switches say. |
| `dailyCallLimit` | `50` (1 to 1000) | Model runs started per UTC day across all features. |
| `transcriptLimit` | `12000` (4000 to 12000) | Characters of conversation text per run; longer text keeps its first 3000 characters and the end (`truncateTranscript`). |

Out-of-range stored values read as the default. `summaryEnabled`, `digestEnabled`, `retroEnabled` and the `workflow-insights` `enabled` switch default to `false`; stored values are kept, so users who turned them on stay on.

## Behavior

- A run claims one call from the ledger (`server/model-calls.ts`, `model-calls.json` in the plugin data folder) before it creates any workspace or session. The claim fails when `sendTextToModels` is off or today's count has reached `dailyCallLimit`. A refused run starts no model session and shows the refusal where that feature shows errors (card summary error, digest error, review error, workflow run reason, session insight error).
- A run counts once; a fallback to the next summary model inside the run is not counted.
- The counter is serialized and replaced atomically. An unreadable file is copied to `model-calls.invalid-<time>.json` and counting restarts from zero.
- Services start with a claim that always refuses; the daemon wires the ledger in `index.server.ts`, so an unwired service sends nothing.
- Automatic triggers (turn end, digest on read, review after Done) are skipped without an error while `sendTextToModels` is off. Manual actions (Refresh, Find memories, Run now) show the refusal.
- Settings → AI features → Text sent to models holds the switch, the daily limit and the text size. The welcome tour's Built in page shows the switch.
- The transcript cap applies to conversation excerpts (card summaries, outside-session insights). Memory review, digest and workflow insights build their input from stored summaries, clues and logs, each already bounded by its own limits.

## Acceptance

- First-run defaults send no model call (`shared/summary.test.ts`, per-service refusal tests).
- The daily cap, restart persistence, day rollover, concurrency and the unreadable file are tested (`server/model-calls.test.ts`).
- The text cap changes the prompt size (`server/summaries.test.ts`, `server/session-insights.test.ts`).
