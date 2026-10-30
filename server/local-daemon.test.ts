import { expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonUnavailable } from "./local-daemon";
import { unavailableWorkspaceRecovery, workspaceRecoveryUnavailable } from "./workspace-restore";

test("no daemon module reads the Paseo local credential", async () => {
  const files = (await readdir(__dirname, { recursive: true })).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) expect(await readFile(join(__dirname, file), "utf8"), file).not.toMatch(/local-credential|localCredential|paseo\.pid/);
});

test("workspace recovery without the SDK fails with a clear message", async () => {
  const failure = await unavailableWorkspaceRecovery.connect().catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(LocalDaemonUnavailable);
  expect((failure as Error).message).toBe(workspaceRecoveryUnavailable);
});
