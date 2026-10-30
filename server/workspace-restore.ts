import { LocalDaemonUnavailable } from "./local-daemon";
import type { BoardStore } from "./store";
import type { BoardEvent } from "../shared/model";
import { isSummarizer } from "../shared/summary";

/** Paseo's answer to "can this archived workspace come back?". */
export type RecoveryState =
  | { kind: "recoverable"; workspaceId: string; workspaceName: string; action: string; branch: string | null }
  | { kind: "unavailable"; workspaceId: string; reason: string; message: string };

/** One short-lived daemon connection for a restore run. */
export interface RecoveryConnection {
  inspect(workspaceId: string): Promise<RecoveryState>;
  restore(workspaceId: string): Promise<void>;
  /** Archived sessions in the workspace. */
  archivedSessions(workspaceId: string): Promise<ArchivedSession[]>;
  /** Unarchives the session and reloads it from persistence (Paseo "refresh"). */
  reviveSession(agentId: string): Promise<void>;
  close(): Promise<void>;
}
export type ArchivedSession = { id: string; archivedAt: string; labels: Record<string, string> };
export interface WorkspaceRecovery {
  connect(): Promise<RecoveryConnection>;
}

export const workspaceRecoveryUnavailable = "Restoring workspaces and sessions needs a Paseo SDK call that does not exist yet.";

export const unavailableWorkspaceRecovery: WorkspaceRecovery = {
  async connect() {
    throw new LocalDaemonUnavailable(workspaceRecoveryUnavailable);
  },
};

const finished = (status: string) => status === "done" || status === "cancelled";

/**
 * Whether the plugin itself archived this card's workspace and has not brought
 * it back since: a wrap-up that archived the workspace, or auto wrap-up.
 */
export function archivedByWrapup(events: BoardEvent[], taskId: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (e.action === "workspace_restored") return false;
    if (e.action === "workspace_auto_archived") return true;
    if (e.action === "wrapped_up" && /(^|; )workspace archived(;|$)/.test(e.note || "")) return true;
  }
  return false;
}

/**
 * Sessions archived by one of this card's wrap-ups: archived at the moment a
 * wrap-up ran (the event is recorded right after archiving, and re-archiving a
 * workspace re-stamps its sessions). Sessions the user archived at other times,
 * and summarizer children, stay archived.
 */
export function sessionsArchivedByWrapup(events: BoardEvent[], taskId: string, sessions: ArchivedSession[]) {
  const times = events
    .filter((e) => e.taskId === taskId && (e.action === "wrapped_up" || e.action === "workspace_auto_archived"))
    .map((e) => Date.parse(e.at));
  return sessions.filter((s) => {
    if (isSummarizer(s)) return false;
    const at = Date.parse(s.archivedAt);
    return times.some((t) => at >= t - 120_000 && at <= t + 5_000);
  });
}

/**
 * Moving a wrapped-up card out of Done/Cancelled brings its workspace back:
 * Paseo unarchives it in place, or recreates a removed worktree on its kept
 * branch, under the same workspace ID, and the sessions its wrap-up archived
 * come back too. Only workspaces the plugin archived, or that the card created,
 * are restored; shared ones (e.g. the project main) are never touched.
 */
export class WorkspaceRestoreService {
  constructor(
    readonly store: BoardStore,
    readonly recovery: WorkspaceRecovery = unavailableWorkspaceRecovery,
  ) {}

  private readonly runs = new Map<string, Promise<void>>();

  restoreAfterReopen(id: string): Promise<void> {
    const pending = this.runs.get(id);
    if (pending) return pending;
    const run = this.once(id).finally(() => this.runs.delete(id));
    this.runs.set(id, run);
    return run;
  }

  private async once(id: string) {
    const record = (action: string, note: string) =>
      this.store.mutate((board) => {
        if (board.tasks.some((t) => t.id === id))
          this.store.event(board, { taskId: id, actor: "system", action, note });
      });
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === id);
    if (!task || task.archivedAt || finished(task.status)) return;
    const wrapped = board.events.some(
      (e) => e.taskId === id && (e.action === "wrapped_up" || e.action === "workspace_auto_archived"),
    );
    const ours = archivedByWrapup(board.events, id);
    const owned = task.ownsWorkspace === true;
    if (!wrapped && !owned) return;
    let daemon: RecoveryConnection;
    try {
      daemon = await this.recovery.connect();
    } catch (e) {
      if (ours) await record("workspace_restore_skipped", e instanceof LocalDaemonUnavailable ? message(e) : `Could not reach Paseo: ${message(e)}`);
      return;
    }
    try {
      let state: RecoveryState;
      try {
        state = await daemon.inspect(task.workspaceId);
      } catch (e) {
        if (ours) await record("workspace_restore_skipped", `Could not reach Paseo: ${message(e)}`);
        return;
      }
      let restored: RecoveryState | null = null;
      if (state.kind === "recoverable") {
        // Someone else archived it: leave the workspace and its sessions alone.
        if (!ours && !owned) return;
        const current = (await this.store.read()).tasks.find((t) => t.id === id);
        if (!current || current.archivedAt || finished(current.status)) return;
        try {
          await daemon.restore(task.workspaceId);
        } catch (e) {
          await record("workspace_restore_skipped", `Restoring failed: ${message(e)}`);
          return;
        }
        restored = state;
      } else if (state.reason !== "workspace_not_archived") {
        if (ours) await record("workspace_restore_skipped", state.message);
        return;
      }
      const revive = sessionsArchivedByWrapup(
        (await this.store.read()).events,
        id,
        await daemon.archivedSessions(task.workspaceId).catch(() => []),
      );
      let revived = 0;
      const failed: string[] = [];
      for (const session of revive) {
        try {
          await daemon.reviveSession(session.id);
          revived++;
        } catch (e) {
          failed.push(`${session.id.slice(0, 8)}: ${message(e)}`);
        }
      }
      const sessions = [
        `${revived} session(s) restored`,
        ...(failed.length ? [`not restored: ${failed.join("; ")}`] : []),
      ].join("; ");
      if (restored)
        await record(
          "workspace_restored",
          `${restored.action === "restore" ? `Worktree recreated${restored.branch ? ` on branch ${restored.branch}` : ""} and workspace restored` : "Workspace restored"}; ${sessions}.`,
        );
      else if (revive.length) await record("sessions_restored", `${sessions}.`);
    } finally {
      await daemon.close();
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
