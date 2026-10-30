import { expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonUnavailable } from "./local-daemon";
import { daemonRevive } from "./background-workspace";
import { unavailableWorkspaceRecovery, workspaceRecoveryUnavailable } from "./workspace-restore";

const root = join(__dirname, "..");
const sourceFolders = ["server", "client", "shared", "scripts", "benchmarks", "docs/verification", "docs/promo"];
const credentialRead = /local-credential|localCredential|paseo\.pid/;

async function sourceFiles(): Promise<string[]> {
  const found = [join(root, "index.server.ts"), join(root, "index.client.tsx")];
  for (const folder of sourceFolders) {
    const entries = await readdir(join(root, folder), { recursive: true }).catch(() => []);
    for (const entry of entries) if (/\.(m?js|tsx?)$/.test(entry)) found.push(join(root, folder, entry));
  }
  return found.filter((file) => !file.endsWith(".test.ts"));
}

test("no source file reads the Paseo local credential", async () => {
  for (const file of await sourceFiles()) expect(await readFile(file, "utf8"), file).not.toMatch(credentialRead);
});

test("workspace recovery without the SDK fails with a clear message", async () => {
  const failure = await unavailableWorkspaceRecovery.connect().catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(LocalDaemonUnavailable);
  expect((failure as Error).message).toBe(workspaceRecoveryUnavailable);
});

test("the background workspace cannot be revived without the SDK", async () => {
  await expect(daemonRevive()("workspace-1")).rejects.toThrow(workspaceRecoveryUnavailable);
});
