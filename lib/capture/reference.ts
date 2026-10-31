/**
 * Same crop policy for reference photos (spec §3: "consistent framing policy
 * for live images and reference crops"). R3 can run each curated Cruella image
 * through this in the browser and save the result + `box` as crop metadata in
 * references/manifest.json.
 */
import { CAPTURE_CONFIG, type CaptureConfig } from "./config";
import { getPoseDetector } from "./detector";
import { clampBox, computeClothingBox, countPeople } from "./framing";
import { renderCrop, toJpegDataUrl } from "./image";
import type { NormBox, Pose } from "./types";

export type ReferenceCrop = { dataUrl: string; box: NormBox; width: number; height: number };

export async function cropReferenceImage(
  img: HTMLImageElement,
  cfg: CaptureConfig = CAPTURE_CONFIG,
): Promise<ReferenceCrop | null> {
  const detector = await getPoseDetector("IMAGE", cfg);
  const poses = detector.detect(img).landmarks as Pose[];
  const { main } = countPeople(poses, cfg);
  const raw = main && computeClothingBox(main, cfg);
  if (!raw) return null;
  const box = clampBox(raw);
  const canvas = renderCrop(img, box, cfg);
  return { dataUrl: toJpegDataUrl(canvas, cfg), box, width: canvas.width, height: canvas.height };
}
