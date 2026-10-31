// Shared camera stream helper.
//
// OWNER: R1 (Integration/UI). R1 owns the single shared camera stream. This is a
// minimal placeholder so R2's capture pipeline can be exercised end-to-end in the
// demo harness. R1 coordinates the real implementation.

export interface CameraOptions {
  width?: number;
  height?: number;
  facingMode?: "user" | "environment";
}

/**
 * Request the webcam. MUST be called from a user gesture (operator setup) so the
 * browser grants camera permission and allows audio playback later.
 */
export async function startCamera(options: CameraOptions = {}): Promise<MediaStream> {
  const { width = 1280, height = 720, facingMode = "user" } = options;
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API unavailable in this environment.");
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: width },
      height: { ideal: height },
      facingMode,
    },
    audio: false,
  });
}

/** Release all tracks when the operator stops the app. */
export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Generate a unique session id for one assessment. */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
