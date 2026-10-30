import { expect, test, vi } from "vitest";

const rn = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
vi.mock("react-native", () => ({ Linking: { openURL: rn.openURL } }));

import { openWebUrl } from "./open-url";

test("http and https links are opened", async () => {
  await openWebUrl("https://example.com/a");
  await openWebUrl("HTTP://example.com/b");
  expect(rn.openURL.mock.calls).toEqual([["https://example.com/a"], ["HTTP://example.com/b"]]);
});

test.each(["javascript:alert(1)", "file:///etc/passwd", "intent://x#Intent;end", "tel:123", "data:text/html,x", "//example.com", "", "example.com"])(
  "%s is refused without opening anything",
  async (url) => {
    rn.openURL.mockClear();
    await expect(openWebUrl(url)).rejects.toThrow("Only http and https links can be opened");
    expect(rn.openURL).not.toHaveBeenCalled();
  },
);
