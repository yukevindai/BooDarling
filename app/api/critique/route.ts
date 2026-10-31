// R4 OWNS. Critique endpoint: { capture, result } -> { sessionId, text, source }.
// Delegates to the server-side orchestrator, which resolves the reference image,
// calls the configured critic provider (gemini | ollama | mock), and falls back to
// a preset line on any failure. Never computes or changes the Aura score.
import { NextResponse } from "next/server";
import { createCritique } from "@/lib/critic/critique";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const outcome = await createCritique(body, { signal: req.signal });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
