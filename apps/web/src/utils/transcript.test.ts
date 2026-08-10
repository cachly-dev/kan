import { describe, expect, it } from "vitest";

import { isTranscriptComment, parseTranscript } from "./transcript";

describe("isTranscriptComment", () => {
  it("recognises the marker inside html", () => {
    expect(
      isTranscriptComment("<p>Transkript (auto) — aufnahme.webm:</p>"),
    ).toBe(true);
  });

  it("ignores ordinary comments", () => {
    expect(isTranscriptComment("<p>Sieht gut aus</p>")).toBe(false);
    expect(isTranscriptComment(null)).toBe(false);
  });
});

describe("parseTranscript", () => {
  it("turns leading timestamps into seconds", () => {
    const lines = parseTranscript(
      "<p>[0:12] Erster Block</p><p>[1:05] Zweiter Block</p>",
    );

    expect(lines).toEqual([
      { seconds: 12, label: "0:12", text: "Erster Block" },
      { seconds: 65, label: "1:05", text: "Zweiter Block" },
    ]);
  });

  it("keeps lines without a timestamp", () => {
    const lines = parseTranscript(
      "Transkript (auto) — datei.webm:\n[0:00] Los",
    );

    expect(lines[0]).toEqual({
      seconds: null,
      label: "",
      text: "Transkript (auto) — datei.webm:",
    });
    expect(lines[1]?.seconds).toBe(0);
  });

  it("does not treat minutes above 59 seconds as a timestamp", () => {
    const [line] = parseTranscript("[0:75] kaputt");

    expect(line?.seconds).toBeNull();
    expect(line?.text).toBe("[0:75] kaputt");
  });

  it("decodes entities and line breaks", () => {
    const [line] = parseTranscript("<p>[0:03] Sonne &amp; Mond<br/></p>");

    expect(line?.text).toBe("Sonne & Mond");
  });
});
