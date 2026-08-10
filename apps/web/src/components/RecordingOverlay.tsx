import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useRef } from "react";
import {
  HiOutlinePause,
  HiOutlinePlay,
  HiOutlineStopCircle,
  HiOutlineVideoCamera,
  HiOutlineVideoCameraSlash,
  HiXMark,
} from "react-icons/hi2";

import { useRecorder } from "~/providers/recorder";

/**
 * cachly: The part of the recorder you cannot miss.
 *
 * A red frame around the viewport says "you are being recorded", the bar
 * stays reachable from every page, and the camera bubble sits where it will
 * end up in the video — drag it and the burnt-in circle follows.
 */

const BUBBLE_RATIO = 0.18;

const formatElapsed = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function RecordingOverlay() {
  const {
    status,
    elapsedSeconds,
    uploadedBytes,
    cameraEnabled,
    cameraAvailable,
    cameraStream,
    bubblePosition,
    setBubblePosition,
    stop,
    cancel,
    togglePause,
    toggleCamera,
  } = useRecorder();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = cameraStream;
    if (cameraStream) void element.play().catch(() => undefined);
  }, [cameraStream]);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    const element = bubbleRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    element.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const offset = dragOffset.current;
      const element = bubbleRef.current;
      if (!offset || !element) return;

      const size = element.getBoundingClientRect().width;
      const maxX = Math.max(window.innerWidth - size, 1);
      const maxY = Math.max(window.innerHeight - size, 1);
      const left = Math.min(Math.max(event.clientX - offset.x, 0), maxX);
      const top = Math.min(Math.max(event.clientY - offset.y, 0), maxY);

      setBubblePosition({
        x: left / window.innerWidth,
        y: top / window.innerHeight,
      });
    },
    [setBubblePosition],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    dragOffset.current = null;
    bubbleRef.current?.releasePointerCapture(event.pointerId);
  }, []);

  if (status === "idle") return null;

  const isPaused = status === "paused";
  const isFinishing = status === "finishing";
  const isPreparing = status === "preparing";
  const bubbleSize = `min(${BUBBLE_RATIO * 100}vw, ${BUBBLE_RATIO * 100}vh)`;

  return (
    <>
      {!isPreparing && (
        <div
          aria-hidden
          className={`pointer-events-none fixed inset-0 z-[90] border-4 ${
            isPaused ? "border-amber-400/80" : "border-red-500/80"
          }`}
          style={{
            boxShadow: isPaused
              ? "inset 0 0 24px rgba(251,191,36,0.25)"
              : "inset 0 0 24px rgba(239,68,68,0.25)",
          }}
        />
      )}

      {cameraAvailable && cameraEnabled && !isFinishing && (
        <div
          ref={bubbleRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="fixed z-[92] cursor-grab touch-none overflow-hidden rounded-full border-2 border-white/80 shadow-lg active:cursor-grabbing"
          style={{
            width: bubbleSize,
            height: bubbleSize,
            left: `${bubblePosition.x * 100}vw`,
            top: `${bubblePosition.y * 100}vh`,
          }}
          aria-label={t`Move camera bubble`}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="h-full w-full scale-x-[-1] object-cover"
          />
        </div>
      )}

      <div className="fixed bottom-4 left-1/2 z-[95] -translate-x-1/2">
        <div className="flex items-center gap-3 rounded-full border border-light-300 bg-light-50 px-4 py-2 shadow-lg dark:border-dark-300 dark:bg-dark-100">
          <span className="flex items-center gap-2 text-sm tabular-nums text-light-1000 dark:text-dark-1000">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                isPaused
                  ? "bg-amber-400"
                  : isFinishing
                    ? "bg-light-600 dark:bg-dark-600"
                    : "animate-pulse bg-red-500"
              }`}
            />
            {isPreparing
              ? t`Starting…`
              : isFinishing
                ? t`Saving…`
                : formatElapsed(elapsedSeconds)}
          </span>

          {!isPreparing && !isFinishing && (
            <>
              <span className="text-xs text-light-900 dark:text-dark-900">
                {formatBytes(uploadedBytes)} {t`secured`}
              </span>

              {cameraAvailable && (
                <button
                  type="button"
                  onClick={toggleCamera}
                  className="rounded-full p-1.5 text-light-1000 transition-colors hover:bg-light-200 dark:text-dark-1000 dark:hover:bg-dark-300"
                  aria-label={cameraEnabled ? t`Hide camera` : t`Show camera`}
                  title={cameraEnabled ? t`Hide camera` : t`Show camera`}
                >
                  {cameraEnabled ? (
                    <HiOutlineVideoCamera className="h-4 w-4" />
                  ) : (
                    <HiOutlineVideoCameraSlash className="h-4 w-4" />
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={togglePause}
                className="rounded-full p-1.5 text-light-1000 transition-colors hover:bg-light-200 dark:text-dark-1000 dark:hover:bg-dark-300"
                aria-label={isPaused ? t`Resume recording` : t`Pause recording`}
                title={isPaused ? t`Resume recording` : t`Pause recording`}
              >
                {isPaused ? (
                  <HiOutlinePlay className="h-4 w-4" />
                ) : (
                  <HiOutlinePause className="h-4 w-4" />
                )}
              </button>

              <button
                type="button"
                onClick={stop}
                className="flex items-center gap-1 rounded-full bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
                aria-label={t`Stop recording`}
              >
                <HiOutlineStopCircle className="h-4 w-4" />
                {t`Stop`}
              </button>

              <button
                type="button"
                onClick={cancel}
                className="rounded-full p-1.5 text-light-900 transition-colors hover:bg-light-200 dark:text-dark-900 dark:hover:bg-dark-300"
                aria-label={t`Discard recording`}
                title={t`Discard recording`}
              >
                <HiXMark className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
