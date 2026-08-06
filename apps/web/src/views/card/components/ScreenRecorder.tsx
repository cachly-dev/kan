import { t } from "@lingui/core/macro";
import { env } from "next-runtime-env";
import { useEffect, useRef, useState } from "react";
import { HiOutlineStopCircle, HiOutlineVideoCamera } from "react-icons/hi2";

import Button from "~/components/Button";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// The upload endpoint rejects bodies above 50MB; warn close to the limit.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const WARN_BYTES = 45 * 1024 * 1024;

const formatElapsed = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export function ScreenRecorder({ cardPublicId }: { cardPublicId: string }) {
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [isSupported, setIsSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  // Feature detection must run client-side only (SSR has no navigator).
  useEffect(() => {
    setIsSupported(
      typeof navigator !== "undefined" &&
        "getDisplayMedia" in navigator.mediaDevices &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  const cleanup = () => {
    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) track.stop();
    }
    streamsRef.current = [];
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Leaving the card while recording must release screen + mic.
  useEffect(() => cleanup, []);

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const uploadRecording = async (blob: Blob) => {
    const timestamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-:]/g, "")
      .replace("T", "-");
    const file = new File([blob], `aufnahme-${timestamp}.webm`, {
      type: blob.type,
    });

    setIsUploading(true);
    try {
      const baseUrl = env("NEXT_PUBLIC_BASE_URL") ?? "";
      const response = await fetch(
        `${baseUrl}/api/upload/attachment?cardPublicId=${encodeURIComponent(cardPublicId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "video/webm",
            "x-original-filename": encodeURIComponent(file.name),
          },
          body: file,
        },
      );
      if (!response.ok) throw new Error("Upload failed");

      await invalidateCard(utils, cardPublicId);
      showPopup({
        header: t`Recording attached`,
        message: t`Your screen recording has been attached to the card.`,
        icon: "success",
      });
    } catch {
      showPopup({
        header: t`Upload failed`,
        message: t`Failed to upload the recording. Please try again.`,
        icon: "error",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const finishRecording = async () => {
    setIsRecording(false);
    cleanup();

    const mimeType = recorderRef.current?.mimeType ?? "video/webm";
    recorderRef.current = null;
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];

    if (blob.size === 0) return;
    if (blob.size > MAX_UPLOAD_BYTES) {
      showPopup({
        header: t`Recording too large`,
        message: t`The recording exceeds the 50MB upload limit. Record a shorter clip.`,
        icon: "error",
      });
      return;
    }
    if (blob.size > WARN_BYTES) {
      showPopup({
        header: t`Recording is close to the limit`,
        message: t`The recording is close to the 50MB upload limit.`,
        icon: "warning",
      });
    }
    await uploadRecording(blob);
  };

  const startRecording = async () => {
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch {
      // Picker dismissed — not an error worth a popup.
      return;
    }
    streamsRef.current.push(display);

    // Microphone is optional: recording proceeds without it if denied.
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamsRef.current.push(mic);
    } catch {
      mic = null;
    }

    const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    const audioTracks = [
      ...display.getAudioTracks(),
      ...(mic?.getAudioTracks() ?? []),
    ];
    const firstAudioTrack = audioTracks[0];
    if (audioTracks.length === 1 && firstAudioTrack) {
      tracks.push(firstAudioTrack);
    } else if (audioTracks.length > 1) {
      // MediaRecorder only records the first audio track of a stream, so
      // multiple sources (tab audio + mic) have to be mixed down to one.
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();
      for (const track of audioTracks) {
        audioContext
          .createMediaStreamSource(new MediaStream([track]))
          .connect(destination);
      }
      tracks.push(...destination.stream.getAudioTracks());
    }

    const mimeType = MIME_CANDIDATES.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    const recorder = new MediaRecorder(
      new MediaStream(tracks),
      mimeType ? { mimeType } : undefined,
    );
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      void finishRecording();
    };
    // The browser's own "stop sharing" UI must end the recording cleanly.
    display.getVideoTracks()[0]?.addEventListener("ended", stopRecording);

    recorder.start(1000);
    setElapsedSeconds(0);
    timerRef.current = window.setInterval(
      () => setElapsedSeconds((seconds) => seconds + 1),
      1000,
    );
    setIsRecording(true);
  };

  if (!isSupported) return null;

  if (isRecording) {
    return (
      <span className="flex items-center gap-1">
        <span className="flex items-center gap-1 px-1 text-xs tabular-nums text-light-900 dark:text-dark-900">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          {formatElapsed(elapsedSeconds)}
        </span>
        <Button
          type="button"
          variant="ghost"
          iconLeft={
            <HiOutlineStopCircle className="h-4 w-4 text-red-500" />
          }
          iconOnly
          size="sm"
          onClick={stopRecording}
          aria-label={t`Stop recording`}
        />
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      iconLeft={
        <HiOutlineVideoCamera className="h-4 w-4 text-light-950 dark:text-dark-950" />
      }
      isLoading={isUploading}
      disabled={isUploading}
      iconOnly
      size="sm"
      onClick={() => void startRecording()}
      aria-label={t`Record screen`}
      title={t`Record screen`}
    />
  );
}
