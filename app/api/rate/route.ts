// Validated proxy to the Python similarity service (spec §7, §8).
//
// OWNER: R3 (Similarity engine).
//
// POST /api/rate : Capture -> RateResult
//
// The server fixes the character/reference set and loads calibration; clients
// cannot supply their own anchors or score (spec §8). This route validates the
// Capture payload, enforces the "decoded image <= 1 MB" contract, and forwards
// only { sessionId, outfitImage } to the server-only SIMILARITY_SERVICE_URL. The
// similarity service is never exposed to the browser.

import type { Capture, RateResult } from "@/lib/types";

// Always run on the server; never statically optimize.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DECODED_IMAGE_BYTES = 1024 * 1024; // 1 MB (spec §8)
const SERVICE_TIMEOUT_MS = 20_000;

function unavailable(sessionId: string, message: string): RateResult {
  return { status: "unavailable", sessionId, message };
}

function json(result: RateResult, status = 200): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Byte length of the base64 payload inside a data URL, without decoding it. */
function decodedByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

export async function POST(request: Request): Promise<Response> {
  // sessionId may be unknown if the body is malformed; keep a safe default so the
  // RateResult always carries one.
  let sessionId = "unknown";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(unavailable(sessionId, "Malformed JSON body."), 400);
  }

  const capture = body as Partial<Capture>;
  if (typeof capture?.sessionId !== "string" || capture.sessionId.length === 0) {
    return json(unavailable(sessionId, "Missing sessionId."), 400);
  }
  sessionId = capture.sessionId;

  if (typeof capture.outfitImage !== "string" || capture.outfitImage.length === 0) {
    return json(unavailable(sessionId, "Missing outfitImage."), 400);
  }
  if (!capture.outfitImage.startsWith("data:image/")) {
    return json(unavailable(sessionId, "outfitImage must be an image data URL."), 400);
  }
  if (decodedByteLength(capture.outfitImage) > MAX_DECODED_IMAGE_BYTES) {
    return json(unavailable(sessionId, "Image exceeds the 1 MB limit."), 413);
  }

  const baseUrl = process.env.SIMILARITY_SERVICE_URL;
  if (!baseUrl) {
    return json(
      unavailable(sessionId, "SIMILARITY_SERVICE_URL is not configured."),
      500
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/rate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Optional auth for a hosted similarity service (server-only token).
        ...(process.env.SIMILARITY_SERVICE_TOKEN
          ? { authorization: `Bearer ${process.env.SIMILARITY_SERVICE_TOKEN}` }
          : {}),
      },
      // Forward only the frozen Capture fields; never pass client-supplied anchors.
      body: JSON.stringify({
        sessionId: capture.sessionId,
        outfitImage: capture.outfitImage,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "Similarity service timed out."
        : "Similarity service is unreachable.";
    return json(unavailable(sessionId, reason), 502);
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return json(unavailable(sessionId, "Invalid response from similarity service."), 502);
  }

  const result = payload as Partial<RateResult> & { sessionId?: string };
  // Trust only well-formed results; pin the sessionId back to this request so a
  // late/mismatched response can be discarded by the caller.
  if (result?.status === "ok" || result?.status === "unavailable") {
    return json({ ...(result as RateResult), sessionId }, 200);
  }
  return json(unavailable(sessionId, "Unexpected response from similarity service."), 502);
}
