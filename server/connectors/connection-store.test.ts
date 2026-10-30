import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionStore } from "./service";
import type { StoredConnection } from "./http";

const PRIVATE_FILE_MODE = 0o600;

const connection: StoredConnection = {
  id: "c1",
  provider: "github",
  name: "GitHub",
  baseUrl: "https://api.github.com",
  email: "",
  secret: "token-value",
  account: "ada",
  login: "ada",
  verifiedAt: "2026-10-30T00:00:00Z",
  authFailed: false,
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function emptyStore() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-connection-store-"));
  directories.push(directory);
  return new ConnectionStore(join(directory, "connections"));
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe("ConnectionStore file permissions", () => {
  test("a new connections file is readable by the owner only", async () => {
    const store = await emptyStore();
    await store.update((list) => void list.push(connection));
    expect(await modeOf(store.path)).toBe(PRIVATE_FILE_MODE);
  });

  test("a rewrite tightens a file left with wider permissions", async () => {
    const store = await emptyStore();
    await store.update((list) => void list.push(connection));
    await chmod(store.path, 0o644);
    await store.update((list) => void list.push({ ...connection, id: "c2" }));
    expect(await modeOf(store.path)).toBe(PRIVATE_FILE_MODE);
  });

  test("the backup copy is readable by the owner only", async () => {
    const store = await emptyStore();
    await store.update((list) => void list.push(connection));
    await store.update((list) => void list.push({ ...connection, id: "c2" }));
    expect(await modeOf(`${store.path}.bak`)).toBe(PRIVATE_FILE_MODE);
  });

  test("the secret stays in the file and the directory is private", async () => {
    const store = await emptyStore();
    await store.update((list) => void list.push(connection));
    expect(await modeOf(store.directory)).toBe(0o700);
    expect((await store.get("c1")).secret).toBe("token-value");
  });
});
