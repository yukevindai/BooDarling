// R3 OWNS. MOCK: replace with validated proxy to SIMILARITY_SERVICE_URL/rate.
import { NextResponse } from "next/server";
import type { Capture, RateResult } from "@/lib/types";

export async function POST(req: Request) {
  const c = (await req.json()) as Capture;
  if (!c?.sessionId || !c.outfitImage?.startsWith("data:image/jpeg"))
    return NextResponse.json({ status: "unavailable", sessionId: c?.sessionId ?? "", message: "Unable to rate this look" } satisfies RateResult, { status: 400 });
  const aura = 40 + (c.outfitImage.length % 55);
  return NextResponse.json({
    status: "ok", sessionId: c.sessionId, aura, lookId: "mock-look", referenceId: "ref-1", similarity: 0.5,
    referenceScores: [{ referenceId: "ref-1", similarity: 0.5 }],
    modelVersion: "mock", referenceVersion: "mock", calibrationVersion: "mock",
  } satisfies RateResult);
}
