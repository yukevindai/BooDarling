// R4 OWNS. MOCK: replace with Qwen3-VL / Gemini critic. Never changes the score.
import { NextResponse } from "next/server";
import type { CritiqueRequest, CritiqueResponse } from "@/lib/types";

export async function POST(req: Request) {
  const { capture } = (await req.json()) as CritiqueRequest;
  return NextResponse.json({
    sessionId: capture.sessionId, source: "preset",
    text: "Finally, someone who understands the importance of making an entrance. Now do try to finish what you started, darling.",
  } satisfies CritiqueResponse);
}
