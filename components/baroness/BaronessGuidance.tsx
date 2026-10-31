"use client";

import { useState } from "react";
import { GUIDANCE_LINES, type GuidanceKey } from "@/lib/critic/lines";
import styles from "./Baroness.module.css";

export type BaronessGuidanceProps = {
  guidance?: GuidanceKey | null;
  className?: string;
};

/**
 * Overlay caption for framing guidance. Fades in when `guidance` is set and fades
 * out (keeping the last text while it fades) when it clears. Position it inside a
 * relatively positioned frame; override placement through `className`.
 */
export function BaronessGuidance({ guidance, className }: BaronessGuidanceProps) {
  const [last, setLast] = useState<GuidanceKey | null>(guidance ?? null);
  if (guidance && guidance !== last) setLast(guidance);
  const visible = !!guidance;
  const line = last ? GUIDANCE_LINES[last] : null;

  return (
    <div
      className={[styles.guidance, className ?? ""].filter(Boolean).join(" ")}
      data-visible={visible ? "true" : "false"}
      data-guidance={guidance ?? undefined}
      role="status"
      aria-live="polite"
    >
      {line && (
        <span className={styles.guidanceEyebrow} aria-hidden={!visible}>
          The Baroness
        </span>
      )}
      {line && (
        <p className={styles.guidanceText} aria-hidden={!visible}>
          {line.text}
        </p>
      )}
    </div>
  );
}
