import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { HiOutlineMicrophone } from "react-icons/hi2";

import Button from "~/components/Button";
import { isVoiceRecordingSupported, useRecorder } from "~/providers/recorder";

/**
 * cachly: The phone half of recording.
 *
 * A screen take needs `getDisplayMedia`, which no mobile browser has — so on a
 * phone the record button simply is not there. A microphone every phone has,
 * and a spoken note runs through the same pipeline: uploaded while it is being
 * spoken, attached to the card, transcribed into a comment.
 */
export function VoiceRecorder({
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
    setIsSupported(isVoiceRecordingSupported());
  }, []);

  if (!isSupported) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      iconLeft={
        <HiOutlineMicrophone className="h-4 w-4 text-light-950 dark:text-dark-950" />
      }
      isLoading={status === "preparing"}
      disabled={status !== "idle"}
      iconOnly
      size="sm"
      onClick={() => void start({ cardPublicId, boardPublicId }, "voice")}
      aria-label={t`Record voice note`}
      title={t`Record voice note`}
    />
  );
}
