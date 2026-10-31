"use client";

import type { CritiqueSource } from "@/lib/critic/types";
import styles from "./Baroness.module.css";

export type BaronessCritiqueProps = {
  text?: string | null;
  status: "idle" | "thinking" | "speaking" | "done";
  /** Debug only: exposed as a `data-source` attribute, never shown to visitors. */
  source?: CritiqueSource;
  speaking?: boolean;
  className?: string;
};

/** Splits "Observation. Suggestion." into its two sentences (falls back to one block). */
export function splitCritique(text: string): { lead: string; follow: string } {
  const m = /^([\s\S]+?[.!?]["”')]?)\s+([\s\S]+)$/.exec(text.trim());
  return m ? { lead: m[1], follow: m[2] } : { lead: text.trim(), follow: "" };
}

export function BaronessCritique({ text, status, source, speaking = false, className }: BaronessCritiqueProps) {
  const thinking = status === "thinking";
  const showText = !thinking && !!text;
  const { lead, follow } = showText ? splitCritique(text as string) : { lead: "", follow: "" };
  const hidden = status === "idle" && !text;

  return (
    <section
      className={[styles.critique, hidden ? styles.critiqueHidden : "", className ?? ""].filter(Boolean).join(" ")}
      data-status={status}
      data-source={source}
      aria-label="The Baroness"
    >
      <div className={styles.byline}>
        <span className={styles.bylineRule} aria-hidden="true" />
        <span className={styles.eyebrow}>The Baroness</span>
        <span className={styles.bars} data-active={speaking ? "true" : "false"} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className={styles.body} aria-live="polite" aria-atomic="true" aria-busy={thinking}>
        {thinking && (
          <p className={styles.thinking}>
            Consulting the archive
            <span className={styles.dots} aria-hidden="true">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </p>
        )}
        {showText && (
          <blockquote className={styles.quote} key={text}>
            <span className={styles.mark} aria-hidden="true">
              &ldquo;
            </span>
            <span className={styles.lead}>{lead}</span>
            {follow && <span className={styles.follow}>{follow}</span>}
          </blockquote>
        )}
      </div>
    </section>
  );
}
