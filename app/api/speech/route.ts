/**
 * POST /api/speech  { sessionId, text } -> audio/mpeg (streamed ElevenLabs TTS)
 * GET  /api/speech  -> BaronessReadiness JSON (no secrets)
 *
 * Aborting the request (visitor left) cancels the upstream ElevenLabs request.
 */
import { elevenLabsReadiness, toElevenLabsError } from "../../../lib/critic/elevenlabs";
import { getSpeechAudio, validateSpeechRequest } from "../../../lib/critic/speech";
import { SPEECH_CONTENT_TYPE } from "../../../lib/critic/speech-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

export async function GET(): Promise<Response> {
  return json(await elevenLabsReadiness(), 200);
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateSpeechRequest(payload);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

  try {
    const result = await getSpeechAudio(parsed.text, { signal: request.signal });
    const headers: Record<string, string> = {
      "Content-Type": SPEECH_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Session-Id": parsed.sessionId,
      "X-Speech-Cache": result.cache,
    };
    if (result.cache === "hit") headers["Content-Length"] = String(result.body.length);
    return new Response(result.body as BodyInit, { status: 200, headers });
  } catch (err) {
    const e = toElevenLabsError(err, request.signal);
    if (e.code === "not_configured") {
      return json({ error: "Speech is not configured", problems: e.message.split("; ") }, 503);
    }
    if (e.code === "aborted") return json({ error: "Request aborted" }, 499);
    // Log server-side only; the message never contains the API key.
    console.error(`[speech] upstream failure (${e.code}${e.status ? ` ${e.status}` : ""}): ${e.message}`);
    return json({ error: "Speech synthesis failed", code: e.code, retryable: e.retryable }, 502, {
      "X-Session-Id": parsed.sessionId,
    });
  }
}

