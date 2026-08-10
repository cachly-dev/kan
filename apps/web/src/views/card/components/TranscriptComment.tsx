import { useMemo } from "react";

import { parseTranscript } from "~/utils/transcript";

export { isTranscriptComment } from "~/utils/transcript";

/**
 * cachly: Renders an auto transcript so its timestamps become jump points.
 * Clicking one asks the media players on this card to seek there.
 */
export function TranscriptComment({ comment }: { comment: string }) {
  const lines = useMemo(() => parseTranscript(comment), [comment]);

  const jumpTo = (seconds: number) => {
    window.dispatchEvent(
      new CustomEvent("kan:seek-media", { detail: { seconds } }),
    );
  };

  return (
    <div className="mt-2 space-y-1 text-sm text-light-1000 dark:text-dark-1000">
      {lines.map((line, index) => (
        <p key={index} className="flex gap-2">
          {line.seconds !== null && (
            <button
              type="button"
              onClick={() => jumpTo(line.seconds ?? 0)}
              className="h-fit shrink-0 rounded bg-light-200 px-1.5 py-0.5 font-mono text-xs tabular-nums text-light-900 transition-colors hover:bg-light-300 dark:bg-dark-300 dark:text-dark-900 dark:hover:bg-dark-400"
              title={`Zu ${line.label} springen`}
            >
              {line.label}
            </button>
          )}
          <span>{line.text}</span>
        </p>
      ))}
    </div>
  );
}
