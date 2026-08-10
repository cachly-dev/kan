/**
 * cachly: Parsing for auto transcript comments.
 *
 * The transcription worker writes plain text through the REST API, so the
 * markup the comment ends up in depends on the editor. Working on text instead
 * of DOM keeps the timestamps clickable no matter how it was stored.
 */

export const TRANSCRIPT_MARKER = "Transkript (auto)";

const TIMESTAMP = /^\[(\d+):([0-5]\d)\]\s*/;

export interface TranscriptLine {
  /** Seconds into the media, or null for lines without a timestamp. */
  seconds: number | null;
  label: string;
  text: string;
}

const decodeEntities = (value: string) =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export const toPlainText = (raw: string) =>
  decodeEntities(
    raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );

export const isTranscriptComment = (raw: string | null | undefined) =>
  typeof raw === "string" && toPlainText(raw).includes(TRANSCRIPT_MARKER);

export const parseTranscript = (raw: string): TranscriptLine[] =>
  toPlainText(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = TIMESTAMP.exec(line);
      const minutePart = match?.[1];
      const secondPart = match?.[2];
      if (!minutePart || !secondPart) {
        return { seconds: null, label: "", text: line };
      }
      return {
        seconds:
          Number.parseInt(minutePart, 10) * 60 +
          Number.parseInt(secondPart, 10),
        label: `${Number.parseInt(minutePart, 10)}:${secondPart}`,
        text: line.replace(TIMESTAMP, ""),
      };
    });
