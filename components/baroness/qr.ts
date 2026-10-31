/**
 * QR code → SVG path (pure; rendered by React, no innerHTML). Uses the `qrcode` package's
 * encoder only. Error correction "M" keeps modules large for scanning off a screen at ~1 m.
 */
import { create } from "qrcode";

export type QrPath = {
  /** Modules per side (without quiet zone). */
  size: number;
  /** Quiet zone in modules on every side (the spec minimum is 4). */
  margin: number;
  /** One `M x y h1 v1 h-1 z` square per dark module, in module units offset by the margin. */
  d: string;
};

export function qrPath(text: string, margin = 4): QrPath {
  const qr = create(text, { errorCorrectionLevel: "M" });
  const { size, data } = qr.modules;
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return { size, margin, d };
}
