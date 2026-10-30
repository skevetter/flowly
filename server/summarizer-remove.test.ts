import { expect, test, vi } from "vitest";
import { archiveRemovedAgent } from "./summarizer-remove";

test("a finished summarizer session is archived", async () => {
  const archive = vi.fn(async () => ({}));
  await archiveRemovedAgent({ id: "child-1", archive });
  expect(archive).toHaveBeenCalledTimes(1);
});

test("a failed archive does not throw", async () => {
  const archive = vi.fn(async () => Promise.reject(new Error("denied")));
  await expect(archiveRemovedAgent({ id: "child-1", archive })).resolves.toBeUndefined();
});
