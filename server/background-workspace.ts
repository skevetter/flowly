import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { Project } from "../shared/model";
import { unavailableWorkspaceRecovery, type WorkspaceRecovery } from "./workspace-restore";
import { logFailure } from "./error-report";

export const BACKGROUND_TITLE = "Flowly background";

/** What the plugin does with a remembered background workspace before a run. */
export type Revival = "live" | "restored" | "gone";
export type Revive = (workspaceId: string) => Promise<Revival>;

/** Anything Paseo cannot bring back (removed, unreachable, no restore call in the SDK) counts as gone: a new one is made. */
export function daemonRevive(recovery: WorkspaceRecovery = unavailableWorkspaceRecovery): Revive {
  return async (workspaceId) => {
    const daemon = await recovery.connect();
    try {
      const state = await daemon.inspect(workspaceId);
      if (state.kind === "recoverable") {
        await daemon.restore(workspaceId);
        return "restored";
      }
      return state.reason === "workspace_not_archived" ? "live" : "gone";
    } finally {
      await daemon.close();
    }
  };
}

const stateSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.string()),
  unarchived: z.array(z.string()).optional(),
});
type State = z.infer<typeof stateSchema>;

/**
 * Project-level temporary sessions (memory review, digest, workflow insights) run in one
 * plugin-owned workspace per project at its root, never in a card's (BACKGROUND-WORKSPACE-SPEC).
 * It is archived when the last run in it ends; the next run restores and reuses it, and only
 * makes a new one when it cannot be brought back.
 */
export class BackgroundWorkspaces {
  private slots = new Map<string, { id: string; users: number }>();
  private locks = new Map<string, Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private revive: Revive = daemonRevive(),
  ) {}
  get path() {
    return join(this.directory, "background-workspaces.json");
  }

  /** Runs `work` with the project's background workspace open; archives it after the last run. */
  async use<T>(project: Project, paseo: PaseoApi, work: (workspaceId: string) => Promise<T>): Promise<T> {
    const id = await this.locked(project.id, async () => {
      const slot = this.slots.get(project.id);
      if (slot) {
        slot.users++;
        return slot.id;
      }
      const id = await this.open(project, paseo);
      this.slots.set(project.id, { id, users: 1 });
      return id;
    });
    try {
      return await work(id);
    } finally {
      await this.locked(project.id, async () => {
        const slot = this.slots.get(project.id);
        if (!slot || --slot.users > 0) return;
        this.slots.delete(project.id);
        if (!(await this.archive(paseo, id))) await this.rememberUnarchived(id);
      });
    }
  }

  private async archive(paseo: PaseoApi, id: string) {
    const failure = await paseo.workspaces.archive(id).then((result) => result?.error, (e) => e);
    if (!failure) return true;
    logFailure("Flowly could not archive its background workspace:", failure);
    return false;
  }

  private rememberUnarchived(id: string) {
    return this.write((state) => (state.unarchived = [...new Set([...(state.unarchived ?? []), id])])).catch((e) =>
      logFailure("Flowly could not record an unarchived background workspace:", e),
    );
  }

  private async archiveLeftovers(paseo: PaseoApi, reused?: string) {
    const { unarchived = [] } = await this.read();
    const inUse = new Set([reused, ...[...this.slots.values()].map((slot) => slot.id)]);
    for (const id of unarchived.filter((leftover) => !inUse.has(leftover))) {
      if (await this.archive(paseo, id)) await this.write((state) => (state.unarchived = state.unarchived?.filter((other) => other !== id)));
    }
  }

  private async open(project: Project, paseo: PaseoApi) {
    const known = (await this.read()).projects[project.id];
    const state = known
      ? await this.revive(known).catch((e) => {
          logFailure("Flowly could not restore its background workspace; making a new one:", e);
          return "gone" as const;
        })
      : "gone";
    const reused = state === "gone" ? undefined : known;
    await this.archiveLeftovers(paseo, reused);
    if (reused) return reused;
    const created = await paseo.workspaces.create({
      title: BACKGROUND_TITLE,
      idempotencyKey: `flowly-background:${project.id}:${randomUUID()}`,
      source: { kind: "directory", path: project.primaryPath, projectId: project.paseoProjectId },
    });
    await this.write((state) => (state.projects[project.id] = created.id));
    return created.id;
  }

  private locked<T>(key: string, job: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(job, job);
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }

  private async read(): Promise<State> {
    await this.tail;
    return this.load();
  }
  private async load(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
      throw new Error(`Background workspace data is invalid; preserved at ${this.path}.`);
    }
  }

  private write(change: (state: State) => void) {
    const job = this.tail.then(async () => {
      const state = await this.load();
      change(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}

/** One per data directory, so memory review, digest and workflow insights share one workspace and count. */
const shared = new Map<string, BackgroundWorkspaces>();
export function backgroundWorkspaces(directory: string) {
  let found = shared.get(directory);
  if (!found) shared.set(directory, (found = new BackgroundWorkspaces(directory)));
  return found;
}
