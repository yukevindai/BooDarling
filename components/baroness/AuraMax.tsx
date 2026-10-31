"use client";
/**
 * Aura-max stage (last results step, after the leaderboard).
 *
 *  - Costume: "Halloween Aura-max" — the next 1–3 pieces the critic saw missing (or, when its
 *    opinion is unknown, the look's top pieces), each with its OWN QR code to an Amazon.ca
 *    search; finishing touches the mirror can't see (hair, makeup) as one text line.
 *  - Scare: "Scare Aura-max" — deterministic facial-expression tips from BooCamp (no QR).
 *
 * Visual only: nothing here is spoken, and nothing changes or predicts a score.
 */
import { useMemo } from "react";
import { amazonSearchUrl } from "@/lib/critic/aura-max";
import type { AuraMax as AuraMaxData, AuraMaxItem } from "@/lib/critic/types";
import type { ScareTip } from "@/lib/expressions/scare";
import { qrPath } from "./qr";
import s from "./AuraMax.module.css";

export type AuraMaxStageData =
  | { kind: "costume"; auraMax: AuraMaxData }
  | { kind: "scare"; score: number; tips: ScareTip[] };

export type AuraMaxStageProps = {
  stage: AuraMaxStageData;
  /** "Face the mirror again": ends the session. */
  onAgain?: () => void;
};

/** The mirror's Aura-max step: picks the costume or scare variant. */
export function AuraMaxStage({ stage, onAgain }: AuraMaxStageProps) {
  return (
    <div className={s.stage} aria-live="polite">
      {stage.kind === "costume" ? <AuraMax auraMax={stage.auraMax} /> : <ScareAuraMax score={stage.score} tips={stage.tips} />}
      {onAgain && (
        <button className={`btn ${s.again}`} onClick={onAgain}>
          FACE THE MIRROR AGAIN
        </button>
      )}
    </div>
  );
}

export default AuraMaxStage;

function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Costume Halloween Aura-max card. */
export function AuraMax({ auraMax }: { auraMax: AuraMaxData }) {
  const { steps, finishing, complete, source, lookLabel } = auraMax;
  const lede = complete
    ? `Aura-max is the full ${lookLabel} look, and the Baroness sees nothing missing from your silhouette.`
    : source === "model"
      ? `Aura-max is the full ${lookLabel} look. Add these next, most important first:`
      : `Aura-max is the full ${lookLabel} look. Complete it, most important first:`;
  return (
    <section className={s.card} aria-label="Halloween Aura-max">
      <p className={s.kicker}>Halloween Aura-max</p>
      <p className={s.lede}>{lede}</p>
      {steps.length > 0 && (
        <ol className={s.steps}>
          {steps.map((item, i) => (
            <Step key={item.id} item={item} index={i} />
          ))}
        </ol>
      )}
      {finishing.length > 0 && (
        <p className={s.finishing}>
          <b>Finishing touches the mirror can’t see:</b> {finishing.map((f) => lower(f.label)).join(" · ")}.
        </p>
      )}
      {steps.length > 0 && <p className={s.note}>Scan a code for an Amazon.ca search. Search links only, no affiliation.</p>}
    </section>
  );
}

function Step({ item, index }: { item: AuraMaxItem; index: number }) {
  const url = amazonSearchUrl(item.search);
  return (
    <li className={s.step}>
      <QrCode text={url} label={`Amazon.ca search for ${item.label}`} />
      <p className={s.stepLabel}>
        <span className={s.ord}>{index === 0 ? "Next" : "Then"}</span> {item.label}
      </p>
      {item.why && <p className={s.why}>{item.why}</p>}
    </li>
  );
}

/** High-contrast QR (black on white, 4-module quiet zone) drawn as one SVG path. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => {
    try {
      return qrPath(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!qr) return null;
  const dim = qr.size + qr.margin * 2;
  return (
    <svg className={s.qr} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shapeRendering="crispEdges" data-qr={text}>
      <rect width={dim} height={dim} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

/** Scare Aura-max: 1–3 expression tips (facial expression only — no shopping, no QR). */
export function ScareAuraMax({ score, tips }: { score: number; tips: ScareTip[] }) {
  const flawless = tips.length === 1 && tips[0].id === "flawless";
  return (
    <section className={s.card} aria-label="Scare Aura-max">
      <p className={s.kicker}>Scare Aura-max</p>
      <p className={s.lede}>
        {flawless ? `Scare Score ${score}. Nothing to fix, darling:` : `Scare Score ${score}. To truly terrify me next time:`}
      </p>
      <ol className={s.tips}>
        {tips.map((t, i) => (
          <li key={t.id} className={s.tip}>
            <span className={s.tipNum} aria-hidden>
              {flawless ? "✦" : i + 1}
            </span>
            <span>
              <b className={s.tipTitle}>{t.title}</b>
              <span className={s.tipDetail}>{t.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
