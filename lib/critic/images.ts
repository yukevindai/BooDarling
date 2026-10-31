/**
 * Image helpers for the critic (server-side only).
 *  - Parse/validate the visitor's outfit data URL.
 *  - Load a reference image from disk, refusing paths outside the project root.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { OUTFIT_IMAGE_MAX_BYTES, type CriticImage } from "./types";

type Mime = CriticImage["mimeType"];

/** Reference images are trusted assets but still capped to keep requests small. */
export const REFERENCE_IMAGE_MAX_BYTES = 4_000_000;

/** Sniff JPEG/PNG/WebP magic bytes. */
export function sniffImageMime(buf: Uint8Array): Mime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return null;
}

export type ParsedDataUrl = { ok: true; image: CriticImage; bytes: number } | { ok: false; error: string };

const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/_-]*={0,2})$/i;

/**
 * Validate an outfit image data URL. JPEG is the contract (spec §8); PNG/WebP
 * are accepted defensively. Decoded size must be ≤ OUTFIT_IMAGE_MAX_BYTES and
 * the bytes must match a known image signature.
 */
export function parseImageDataUrl(value: unknown, maxBytes: number = OUTFIT_IMAGE_MAX_BYTES): ParsedDataUrl {
  if (typeof value !== "string" || value.length === 0) return { ok: false, error: "outfitImage must be a data URL string" };
  // Quick upper bound before running the regex / decoding: base64 inflates by 4/3.
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 64) return { ok: false, error: "outfitImage is too large" };
  const m = DATA_URL_RE.exec(value.trim().replace(/\s+/g, ""));
  if (!m) return { ok: false, error: "outfitImage must be a base64 image data URL (image/jpeg)" };
  const b64 = m[2].replace(/-/g, "+").replace(/_/g, "/");
  if (b64.length === 0) return { ok: false, error: "outfitImage is empty" };
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return { ok: false, error: "outfitImage is empty" };
  if (buf.length > maxBytes) return { ok: false, error: "outfitImage is too large" };
  const sniffed = sniffImageMime(buf);
  if (!sniffed) return { ok: false, error: "outfitImage is not a valid JPEG/PNG/WebP image" };
  // Re-encode so providers always get canonical standard base64.
  return { ok: true, image: { mimeType: sniffed, base64: buf.toString("base64") }, bytes: buf.length };
}

const EXT_MIME: Record<string, Mime> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** True when `target` is `root` or lies inside it (after resolution). */
export function isInsideRoot(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Load a reference image from disk. `absPath` must resolve inside `root`.
 * Mime comes from magic bytes, falling back to the extension.
 */
export async function loadReferenceImage(absPath: string, root: string): Promise<CriticImage> {
  const resolved = path.resolve(absPath);
  if (!isInsideRoot(root, resolved)) throw new Error("reference image path escapes the project root");
  const ext = path.extname(resolved).toLowerCase();
  if (!(ext in EXT_MIME)) throw new Error(`unsupported reference image type: ${ext || "(none)"}`);
  // Also refuse symlinks that point outside the root.
  const [realFile, realRoot] = await Promise.all([realpath(resolved), realpath(path.resolve(root))]);
  if (!isInsideRoot(realRoot, realFile)) throw new Error("reference image path escapes the project root");
  const buf = await readFile(realFile);
  if (buf.length === 0) throw new Error("reference image is empty");
  if (buf.length > REFERENCE_IMAGE_MAX_BYTES) throw new Error("reference image is too large");
  const mimeType = sniffImageMime(buf) ?? EXT_MIME[ext];
  return { mimeType, base64: buf.toString("base64") };
}
