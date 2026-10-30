import { expect, test } from "vitest";
import { displayableImage, extractImages, isRemoteImage, localImagePath, mayRequestImage } from "./images";

test("pasted-image placeholders and markdown images are extracted in order", () => {
  const r = extractImages("Look at this [Image: source: /private/tmp/a/images/1.png]\nand ![chart](https://x.y/c.png) ok");
  expect(r.images).toEqual([
    { src: "/private/tmp/a/images/1.png", alt: "Image" },
    { src: "https://x.y/c.png", alt: "chart" },
  ]);
  expect(r.text).toBe("Look at this \nand  ok".replace(/[ \t]+\n/g, "\n"));
});

test("non-image or relative references stay as text; duplicates collapse", () => {
  const r = extractImages("![doc](notes.md) ![rel](img/a.png) ![x](file:///tmp/a.jpg) ![y](file:///tmp/a.jpg)");
  expect(r.images).toEqual([{ src: "file:///tmp/a.jpg", alt: "x" }]);
  expect(r.text).toContain("![doc](notes.md)");
  expect(r.text).toContain("![rel](img/a.png)");
});

test("displayable and local path rules", () => {
  expect(displayableImage("/a/b.PNG")).toBe(true);
  expect(displayableImage("/a/b.txt")).toBe(false);
  expect(displayableImage("relative.png")).toBe(false);
  expect(displayableImage("https://x/y")).toBe(true);
  expect(localImagePath("file:///a/b.png")).toBe("/a/b.png");
  expect(localImagePath("https://x/y.png")).toBeNull();
});

test("a remote image is not requested by default", () => {
  expect(mayRequestImage("https://x.y/c.png", { autoLoadRemote: false, approved: false })).toBe(false);
  expect(mayRequestImage("http://x.y/c.png", { autoLoadRemote: false, approved: false })).toBe(false);
});

test("a remote image is requested after approval or when auto-load is on", () => {
  expect(mayRequestImage("https://x.y/c.png", { autoLoadRemote: false, approved: true })).toBe(true);
  expect(mayRequestImage("https://x.y/c.png", { autoLoadRemote: true, approved: false })).toBe(true);
});

test("local images never need approval", () => {
  expect(mayRequestImage("/tmp/a.png", { autoLoadRemote: false, approved: false })).toBe(true);
  expect(mayRequestImage("file:///tmp/a.png", { autoLoadRemote: false, approved: false })).toBe(true);
  expect(isRemoteImage("HTTPS://x.y/c.png")).toBe(true);
  expect(isRemoteImage("/tmp/a.png")).toBe(false);
});
