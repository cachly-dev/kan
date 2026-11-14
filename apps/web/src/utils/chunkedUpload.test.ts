import { afterEach, describe, expect, it, vi } from "vitest";

import { SINGLE_SHOT_MAX_BYTES, uploadFileInParts } from "./chunkedUpload";

vi.mock("next-runtime-env", () => ({ env: () => "" }));

const MB = 1024 * 1024;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const fakeStorage = (failPart?: number) => {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body;
    calls.push({ url, method: init.method ?? "GET", body });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });

    if (url.startsWith("/api/upload/start")) {
      return json({
        key: "7/card1/abc-video.mp4",
        uploadId: "up1",
        filename: "video.mp4",
        originalFilename: "video.mp4",
        contentType: "video/mp4",
      });
    }
    if (url.startsWith("/api/upload/part")) {
      const partNumber = Number(
        new URL(url, "http://x").searchParams.get("partNumber"),
      );
      if (partNumber === failPart) return new Response("", { status: 500 });
      return json({ partNumber, etag: `"e${partNumber}"` });
    }
    if (url.startsWith("/api/upload/finish")) {
      return json({ key: "7/card1/abc-video.mp4" });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("uploadFileInParts", () => {
  it("sends a 100MiB file as 12MB parts plus the tail, then seals it", async () => {
    const calls = fakeStorage();
    const file = new File([new Uint8Array(100 * MB)], "video.mp4", {
      type: "video/mp4",
    });
    expect(file.size).toBeGreaterThan(SINGLE_SHOT_MAX_BYTES);

    await uploadFileInParts("card1", file);

    const start = calls.find((c) => c.url.startsWith("/api/upload/start"));
    expect(JSON.parse(String(start?.body))).toMatchObject({
      filename: "video.mp4",
      contentType: "video/mp4",
      size: 100 * MB,
      cardPublicId: "card1",
    });

    const parts = calls.filter((c) => c.url.startsWith("/api/upload/part"));
    const sizes = parts.map((c) => (c.body as Blob).size);
    expect(sizes).toEqual([...Array<number>(8).fill(12 * MB), 4 * MB]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100 * MB);

    const finish = calls.find((c) => c.url.startsWith("/api/upload/finish"));
    const sealed = JSON.parse(String(finish?.body)) as {
      parts: { partNumber: number }[];
      size: number;
    };
    expect(sealed.parts.map((p) => p.partNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(sealed.size).toBe(100 * MB);
  });

  it("aborts and never seals when a part keeps failing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeStorage(2);
    const file = new File([new Uint8Array(40 * MB)], "video.mp4", {
      type: "video/mp4",
    });

    await expect(uploadFileInParts("card1", file)).rejects.toThrow();

    expect(calls.some((c) => c.url.startsWith("/api/upload/finish"))).toBe(
      false,
    );
    expect(calls.some((c) => c.url.startsWith("/api/upload/abort"))).toBe(
      true,
    );
  });
});
