/**
 * POST /api/speech  { sessionId, text } -> audio/mpeg (streamed ElevenLabs TTS)
 * GET  /api/speech  -> BaronessReadiness JSON (no secrets)
 *
 * Aborting the request (visitor left) cancels the upstream ElevenLabs request.
 */
import { elevenLabsReadiness, toElevenLabsError } from "../../../lib/critic/elevenlabs";
import {
  getSpeechAudio,
  safeJsonResponse,
  speechAudioResponse,
  validateSpeechRequest,
  type SpeechResult,
} from "../../../lib/critic/speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return safeJsonResponse(body, status, extra);
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

  let result: SpeechResult;
  try {
    result = await getSpeechAudio(parsed.text, { signal: request.signal });
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

  // Cancels the upstream stream if the response cannot be built.
  const response = await speechAudioResponse(result, parsed.sessionId);
  if (response) return response;
  console.error("[speech] could not build the audio response");
  return json({ error: "Speech response could not be built" }, 500);
}

