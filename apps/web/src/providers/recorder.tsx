import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { FinishResult, UploadTargetRef } from "~/utils/chunkedUpload";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { ChunkedUpload, uploadSmallFile } from "~/utils/chunkedUpload";

/**
 * cachly: One recorder for the whole app.
 *
 * It used to live inside the card view, which had two consequences the user
 * felt directly: you could not record while creating a card, and closing the
 * card killed the take without a word. The recorder now sits above the router,
 * so a take survives navigation and always has a visible stop button.
 */

export type RecorderStatus =
  | "idle"
  | "preparing"
  | "recording"
  | "paused"
  | "finishing";

export interface RecorderTarget {
  /** Attach straight to this card when set. */
  cardPublicId?: string;
  /** Required for drafts: the board decides which workspace may be written. */
  boardPublicId?: string;
}

/**
 * A screen take needs a desktop browser; a voice note works on a phone. Same
 * pipeline, same transcription — only the sources differ.
 */
export type RecorderMode = "screen" | "voice";

export interface DraftRecording {
  key: string;
  originalFilename: string;
  contentType: string;
  size: number;
  posterKey?: string;
  posterFilename?: string;
}

interface RecorderContextValue {
  status: RecorderStatus;
  mode: RecorderMode;
  elapsedSeconds: number;
  uploadedBytes: number;
  cameraEnabled: boolean;
  cameraAvailable: boolean;
  bubblePosition: { x: number; y: number };
  cameraStream: MediaStream | null;
  drafts: DraftRecording[];
  isRecording: boolean;
  start: (target: RecorderTarget, mode?: RecorderMode) => Promise<void>;
  stop: () => void;
  cancel: () => void;
  togglePause: () => void;
  toggleCamera: () => void;
  setBubblePosition: (position: { x: number; y: number }) => void;
  removeDraft: (key: string) => void;
  takeDrafts: () => DraftRecording[];
}

const RecorderContext = createContext<RecorderContextValue | null>(null);

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// Safari on iOS only produces mp4 here, so the fallbacks matter.
const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const CAMERA_PREFERENCE_KEY = "kan:recorder:camera";
const BUBBLE_DIAMETER_RATIO = 0.18; // of the shorter video edge
const CHUNK_MS = 2000;

const readCameraPreference = () => {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CAMERA_PREFERENCE_KEY) !== "off";
};

const extensionFor = (mimeType: string) => {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  if (mimeType.startsWith("audio/")) return "webm";
  return "webm";
};

const timestampName = (mode: RecorderMode, mimeType: string) => {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const prefix = mode === "voice" ? "sprachnotiz" : "aufnahme";
  return `${prefix}-${stamp}.${extensionFor(mimeType)}`;
};

export function RecorderProvider({ children }: { children: ReactNode }) {
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [mode, setMode] = useState<RecorderMode>("screen");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [bubblePosition, setBubblePosition] = useState({ x: 0.04, y: 0.72 });
  const [drafts, setDrafts] = useState<DraftRecording[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const uploadRef = useRef<ChunkedUpload | null>(null);
  const targetRef = useRef<RecorderTarget>({});
  const filenameRef = useRef<string>("aufnahme.webm");
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const posterRef = useRef<Blob | null>(null);
  const cancelledRef = useRef(false);
  const draftsRef = useRef<DraftRecording[]>([]);
  // The draw loop reads these through refs so it never restarts on re-render.
  const cameraEnabledRef = useRef(true);
  const bubbleRef = useRef({ x: 0.04, y: 0.72 });

  useEffect(() => {
    setCameraEnabled(readCameraPreference());
    cameraEnabledRef.current = readCameraPreference();
  }, []);

  useEffect(() => {
    bubbleRef.current = bubblePosition;
  }, [bubblePosition]);

  const releaseHardware = useCallback(() => {
    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) track.stop();
    }
    streamsRef.current = [];
    setCameraStream(null);
    setCameraAvailable(false);

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    screenVideoRef.current = null;
    cameraVideoRef.current = null;
    canvasRef.current = null;
  }, []);

  const capturePoster = useCallback(() => {
    const source = canvasRef.current ?? screenVideoRef.current;
    if (!source) return;

    const width =
      source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
    const height =
      source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
    if (!width || !height) return;

    const scale = Math.min(1, 640 / width);
    const target = document.createElement("canvas");
    target.width = Math.round(width * scale);
    target.height = Math.round(height * scale);
    const ctx = target.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(source, 0, 0, target.width, target.height);
    target.toBlob(
      (blob) => {
        if (blob) posterRef.current = blob;
      },
      "image/jpeg",
      0.7,
    );
  }, []);

  const finalise = useCallback(async () => {
    const upload = uploadRef.current;
    const target = targetRef.current;
    const filename = filenameRef.current;
    const poster = posterRef.current;

    uploadRef.current = null;
    posterRef.current = null;
    releaseHardware();

    if (!upload) {
      setStatus("idle");
      return;
    }

    if (cancelledRef.current) {
      await upload.abort();
      setStatus("idle");
      return;
    }

    setStatus("finishing");

    const targetRef2: UploadTargetRef = {
      cardPublicId: target.cardPublicId,
      boardPublicId: target.boardPublicId,
    };

    let result: FinishResult;
    try {
      result = await upload.finish();
    } catch {
      showPopup({
        header: t`Recording could not be saved`,
        message: t`The upload did not finish. The recording is gone — please try again.`,
        icon: "error",
      });
      setStatus("idle");
      return;
    }

    let posterResult: FinishResult | null = null;
    if (poster) {
      try {
        // The poster is matched to its video by filename, which keeps the
        // thumbnail working without a schema change.
        posterResult = await uploadSmallFile(
          targetRef2,
          poster,
          `${filename}.jpg`,
          "image/jpeg",
        );
      } catch {
        posterResult = null;
      }
    }

    if (target.cardPublicId) {
      await invalidateCard(utils, target.cardPublicId);
      showPopup({
        header: t`Recording attached`,
        message: t`Your recording has been attached to the card.`,
        icon: "success",
      });
    } else {
      draftsRef.current = [
        ...draftsRef.current,
        {
          key: result.key,
          originalFilename: filename,
          contentType: result.contentType ?? "video/webm",
          size: result.size ?? 0,
          posterKey: posterResult?.key,
          posterFilename: posterResult ? `${filename}.jpg` : undefined,
        },
      ];
      setDrafts(draftsRef.current);
      showPopup({
        header: t`Recording ready`,
        message: t`The recording is attached to the card you are creating.`,
        icon: "success",
      });
    }

    setStatus("idle");
    setElapsedSeconds(0);
    setUploadedBytes(0);
  }, [releaseHardware, showPopup, utils]);

  const buildCompositeStream = useCallback(
    (display: MediaStream, camera: MediaStream | null) => {
      const [videoTrack] = display.getVideoTracks();
      if (!videoTrack) return null;
      if (!camera) return null;

      const settings = videoTrack.getSettings();
      const width = settings.width ?? 1280;
      const height = settings.height ?? 720;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const screenVideo = document.createElement("video");
      screenVideo.srcObject = display;
      screenVideo.muted = true;
      screenVideo.playsInline = true;
      void screenVideo.play().catch(() => undefined);
      screenVideoRef.current = screenVideo;

      const cameraVideo = document.createElement("video");
      cameraVideo.srcObject = camera;
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      void cameraVideo.play().catch(() => undefined);
      cameraVideoRef.current = cameraVideo;

      const draw = () => {
        rafRef.current = requestAnimationFrame(draw);
        if (screenVideo.readyState >= 2) {
          ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
        }
        if (cameraEnabledRef.current && cameraVideo.readyState >= 2) {
          const diameter =
            Math.min(canvas.width, canvas.height) * BUBBLE_DIAMETER_RATIO;
          const radius = diameter / 2;
          const centreX = bubbleRef.current.x * canvas.width + radius;
          const centreY = bubbleRef.current.y * canvas.height + radius;

          // Cover-fit the camera frame inside the circle so faces are not
          // squashed when the webcam aspect ratio differs.
          const sourceSize = Math.min(
            cameraVideo.videoWidth,
            cameraVideo.videoHeight,
          );
          const sourceX = (cameraVideo.videoWidth - sourceSize) / 2;
          const sourceY = (cameraVideo.videoHeight - sourceSize) / 2;

          ctx.save();
          ctx.beginPath();
          ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(
            cameraVideo,
            sourceX,
            sourceY,
            sourceSize,
            sourceSize,
            centreX - radius,
            centreY - radius,
            diameter,
            diameter,
          );
          ctx.restore();

          ctx.save();
          ctx.beginPath();
          ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
          ctx.lineWidth = Math.max(2, diameter * 0.03);
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.stroke();
          ctx.restore();
        }
      };
      draw();

      return canvas.captureStream(30);
    },
    [],
  );

  const start = useCallback(
    async (target: RecorderTarget, nextMode: RecorderMode = "screen") => {
      if (status !== "idle") return;
      setStatus("preparing");
      setMode(nextMode);
      cancelledRef.current = false;

      let display: MediaStream | null = null;
      if (nextMode === "screen") {
        try {
          display = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
        } catch {
          // Picker dismissed — not an error worth a popup.
          setStatus("idle");
          return;
        }
        streamsRef.current.push(display);
      }

      let microphone: MediaStream | null = null;
      let camera: MediaStream | null = null;

      try {
        microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamsRef.current.push(microphone);
      } catch {
        microphone = null;
        // Without a screen there is nothing left to record.
        if (nextMode === "voice") {
          showPopup({
            header: t`No microphone`,
            message: t`Without microphone access there is nothing to record.`,
            icon: "error",
          });
          releaseHardware();
          setStatus("idle");
          return;
        }
      }

      if (nextMode === "screen" && readCameraPreference()) {
        try {
          camera = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
          });
          streamsRef.current.push(camera);
          setCameraStream(camera);
          setCameraAvailable(true);
        } catch {
          camera = null;
        }
      }

      const composite = display ? buildCompositeStream(display, camera) : null;
      const videoTracks = composite
        ? composite.getVideoTracks()
        : (display?.getVideoTracks() ?? []);

      const audioTracks = [
        ...(display?.getAudioTracks() ?? []),
        ...(microphone?.getAudioTracks() ?? []),
      ];
      const tracks: MediaStreamTrack[] = [...videoTracks];
      const firstAudioTrack = audioTracks[0];
      if (audioTracks.length === 1 && firstAudioTrack) {
        tracks.push(firstAudioTrack);
      } else if (audioTracks.length > 1) {
        // MediaRecorder only records the first audio track of a stream, so
        // tab audio and microphone have to be mixed down to one.
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

      const candidates =
        nextMode === "voice" ? AUDIO_MIME_CANDIDATES : MIME_CANDIDATES;
      const mimeType = candidates.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = new MediaRecorder(
        new MediaStream(tracks),
        mimeType ? { mimeType } : undefined,
      );

      const fallbackType = nextMode === "voice" ? "audio/webm" : "video/webm";
      const filename = timestampName(
        nextMode,
        recorder.mimeType || fallbackType,
      );
      filenameRef.current = filename;
      targetRef.current = target;
      const upload = new ChunkedUpload(
        {
          cardPublicId: target.cardPublicId,
          boardPublicId: target.boardPublicId,
        },
        filename,
        recorder.mimeType || fallbackType,
      );
      uploadRef.current = upload;

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        upload.add(event.data);
        setUploadedBytes(upload.uploadedBytes);
      };
      recorder.onstop = () => {
        void finalise();
      };
      recorderRef.current = recorder;

      // The browser's own "stop sharing" button must end the take cleanly.
      display?.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      });

      recorder.start(CHUNK_MS);
      setElapsedSeconds(0);
      setUploadedBytes(0);
      setStatus("recording");
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((seconds) => seconds + 1);
      }, 1000);

      if (nextMode === "screen") {
        // Give the sources a moment to paint before grabbing the poster frame.
        window.setTimeout(capturePoster, 1500);
      }
    },
    [
      buildCompositeStream,
      capturePoster,
      finalise,
      releaseHardware,
      showPopup,
      status,
    ],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    cancelledRef.current = false;
    recorder.stop();
    recorderRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    cancelledRef.current = true;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      recorderRef.current = null;
    } else {
      void finalise();
    }
  }, [finalise]);

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setStatus("paused");
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } else if (recorder.state === "paused") {
      recorder.resume();
      setStatus("recording");
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((seconds) => seconds + 1);
      }, 1000);
    }
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraEnabled((enabled) => {
      const next = !enabled;
      cameraEnabledRef.current = next;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CAMERA_PREFERENCE_KEY, next ? "on" : "off");
      }
      return next;
    });
  }, []);

  const removeDraft = useCallback((key: string) => {
    draftsRef.current = draftsRef.current.filter((draft) => draft.key !== key);
    setDrafts(draftsRef.current);
  }, []);

  /**
   * Hands the pending drafts to the caller and clears them in one go. It reads
   * from a ref because a state updater would not have run yet when the card
   * form needs the list.
   */
  const takeDrafts = useCallback(() => {
    const taken = draftsRef.current;
    draftsRef.current = [];
    setDrafts([]);
    return taken;
  }, []);

  // Closing the tab mid-take loses whatever has not been uploaded yet, so the
  // browser gets to warn about it.
  useEffect(() => {
    if (
      status !== "recording" &&
      status !== "paused" &&
      status !== "finishing"
    ) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);

  const value = useMemo<RecorderContextValue>(
    () => ({
      status,
      mode,
      elapsedSeconds,
      uploadedBytes,
      cameraEnabled,
      cameraAvailable,
      bubblePosition,
      cameraStream,
      drafts,
      isRecording: status === "recording" || status === "paused",
      start,
      stop,
      cancel,
      togglePause,
      toggleCamera,
      setBubblePosition,
      removeDraft,
      takeDrafts,
    }),
    [
      bubblePosition,
      cameraAvailable,
      cameraEnabled,
      cameraStream,
      cancel,
      drafts,
      elapsedSeconds,
      mode,
      removeDraft,
      start,
      status,
      stop,
      takeDrafts,
      toggleCamera,
      togglePause,
      uploadedBytes,
    ],
  );

  return (
    <RecorderContext.Provider value={value}>
      {children}
    </RecorderContext.Provider>
  );
}

export const useRecorder = () => {
  const context = useContext(RecorderContext);
  if (!context) {
    throw new Error("useRecorder must be used inside a RecorderProvider");
  }
  return context;
};

export const isScreenRecordingSupported = () =>
  isVoiceRecordingSupported() &&
  "getDisplayMedia" in navigator.mediaDevices;

/**
 * Phones can do this even though they cannot record a screen — which is the
 * whole point of the voice note.
 */
export const isVoiceRecordingSupported = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices !== "undefined" &&
  "getUserMedia" in navigator.mediaDevices &&
  typeof MediaRecorder !== "undefined";
