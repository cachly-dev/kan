import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { HiOutlineVideoCamera } from "react-icons/hi2";

import Button from "~/components/Button";
import { isScreenRecordingSupported, useRecorder } from "~/providers/recorder";

/**
 * cachly: Just the trigger. Everything about a running take — timer, stop,
 * pause, camera bubble, red frame — lives in the global recorder so it stays
 * reachable after this card is closed.
 *
 * Pass `cardPublicId` to attach straight to a card, or `boardPublicId` to
 * record while the card is still being written (the take is uploaded as a
 * draft and bound to the card on save).
 */
export function ScreenRecorder({
  cardPublicId,
  boardPublicId,
}: {
  cardPublicId?: string;
  boardPublicId?: string;
}) {
  const { start, status } = useRecorder();
  const [isSupported, setIsSupported] = useState(false);

  // Feature detection must run client-side only (SSR has no navigator).
  useEffect(() => {
    setIsSupported(isScreenRecordingSupported());
  }, []);

  if (!isSupported) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      iconLeft={
        <HiOutlineVideoCamera className="h-4 w-4 text-light-950 dark:text-dark-950" />
      }
      isLoading={status === "preparing"}
      disabled={status !== "idle"}
      iconOnly
      size="sm"
      onClick={() => void start({ cardPublicId, boardPublicId })}
      aria-label={t`Record screen`}
      title={t`Record screen`}
    />
  );
}
