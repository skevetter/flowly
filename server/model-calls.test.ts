import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ModelCallBlocked, ModelCallLedger } from "./model-calls";

let directory: string;
let clock: Date;
const allowed = (dailyCallLimit: number) => ({ sendTextToModels: true, dailyCallLimit });
const ledger = () => new ModelCallLedger(directory, () => clock);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "flowly-model-calls-"));
  clock = new Date("2026-10-30T10:00:00Z");
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("a first claim with text sharing off is refused and counts nothing", async () => {
  const calls = ledger();
  await expect(calls.claim({ sendTextToModels: false, dailyCallLimit: 50 })).rejects.toThrow(ModelCallBlocked);
  await calls.claim(allowed(1));
});

test("one claim within the limit passes", async () => {
  await expect(ledger().claim(allowed(1))).resolves.toBeUndefined();
});

test("claims beyond the daily limit are refused", async () => {
  const calls = ledger();
  await calls.claim(allowed(2));
  await calls.claim(allowed(2));
  await expect(calls.claim(allowed(2))).rejects.toThrow(/daily limit of 2/);
});

test("concurrent claims never exceed the limit", async () => {
  const calls = ledger();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => calls.claim(allowed(3))));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
});

test("the count survives a restart", async () => {
  await ledger().claim(allowed(1));
  await expect(ledger().claim(allowed(1))).rejects.toThrow(ModelCallBlocked);
});

test("a new day starts at zero", async () => {
  const calls = ledger();
  await calls.claim(allowed(1));
  clock = new Date("2026-10-31T00:00:01Z");
  await expect(calls.claim(allowed(1))).resolves.toBeUndefined();
});

test("lowering the limit applies to calls already made today", async () => {
  const calls = ledger();
  await calls.claim(allowed(5));
  await calls.claim(allowed(5));
  await expect(calls.claim(allowed(2))).rejects.toThrow(ModelCallBlocked);
});

test("an unreadable counter file is kept aside and counting restarts", async () => {
  await writeFile(join(directory, "model-calls.json"), "{not json");
  await expect(ledger().claim(allowed(1))).resolves.toBeUndefined();
  const names = await readdir(directory);
  const kept = names.find((n) => n.startsWith("model-calls.invalid-"));
  expect(kept).toBeDefined();
  expect(await readFile(join(directory, kept!), "utf8")).toBe("{not json");
});
