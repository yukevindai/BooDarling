// R4 OWNS. MOCK: replace with ElevenLabs TTS (server-side key). 501 => client keeps text only.
import { NextResponse } from "next/server";
export async function POST() {
  return NextResponse.json({ error: "speech not implemented" }, { status: 501 });
}
