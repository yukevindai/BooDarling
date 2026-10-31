"use client";
// OWNER: R1 (Integration/UI) owns the real hands-free mirror shell.
//
// This page is an R3 TEST HARNESS, not the final UI. It exercises the similarity
// engine end-to-end without the camera: pick an outfit photo, it is encoded to a
// JPEG data URL and POSTed to /api/rate, and the RateResult (Aura Score, matched
// look, per-reference similarities) is shown. R1 replaces this with the automatic
// capture -> score reveal flow.

import { useCallback, useRef, useState } from "react";
import type { Capture, RateResult } from "@/lib/types";

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Re-encode any picked image to JPEG and keep it under the 1 MB decoded cap (spec §8).
async function fileToOutfitJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 768;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const url = canvas.toDataURL("image/jpeg", q);
    const bytes = Math.floor((url.length - url.indexOf(",") - 1) * 0.75);
    if (bytes <= 1024 * 1024) return url;
  }
  return canvas.toDataURL("image/jpeg", 0.5);
}

function referenceImageUrl(lookId: string, referenceId: string): string {
  const n = referenceId.split("-").pop() ?? "";
  return `/references/cruella/${lookId}/${n}.png`;
}

export default function RatingHarness() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<RateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outfitImage = await fileToOutfitJpeg(file);
      setPreview(outfitImage);
      const capture: Capture = { sessionId: newSessionId(), outfitImage };
      const res = await fetch("/api/rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(capture),
      });
      setResult((await res.json()) as RateResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <main className="demo-wrap">
      <h1 className="demo-title">Reflect · Aura</h1>
      <p className="demo-sub">R3 similarity harness — pick an outfit, darling.</p>

      <div className="demo-controls">
        <button
          className="demo-btn"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Rating…" : "Choose outfit photo"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = "";
          }}
        />
      </div>

      {error ? <p style={{ color: "var(--red)" }}>{error}</p> : null}

      {result?.status === "ok" ? (
        <section>
          <div className="r3-aura">
            <span className="r3-aura__num">{result.aura}</span>
            <span className="r3-aura__label">Aura · {result.lookId}</span>
          </div>
        </section>
      ) : null}

      {result?.status === "unavailable" ? (
        <p style={{ color: "var(--red)" }}>Unable to rate this look — {result.message}</p>
      ) : null}

      {result ? (
        <section className="demo-result">
          {preview ? (
            <figure style={{ margin: 0 }}>
              <img src={preview} alt="Your outfit" />
              <figcaption className="demo-sub">You</figcaption>
            </figure>
          ) : null}
          {result.status === "ok" ? (
            <figure style={{ margin: 0 }}>
              <img
                src={referenceImageUrl(result.lookId, result.referenceId)}
                alt="Closest reference"
              />
              <figcaption className="demo-sub">
                Closest: {result.referenceId} · {result.similarity.toFixed(3)}
              </figcaption>
            </figure>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <pre className="demo-meta">{JSON.stringify(result, null, 2)}</pre>
      ) : null}
    </main>
  );
}
