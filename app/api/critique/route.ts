/**
 * POST /api/critique  { capture, result } -> { sessionId, text, source }
 * GET  /api/critique  -> BaronessReadiness JSON (critic provider + reference manifest; no secrets)
 *
 * The score is never changed here. Critic failures degrade to preset lines (200).
 * Aborting the request (visitor left) cancels the upstream model call.
 */
import { criticTimeoutMs, unknownCriticProvider } from "../../../lib/critic/config";
import { CRITIQUE_MAX_BODY_BYTES, createCritique } from "../../../lib/critic/critique";
import { manifestStatus } from "../../../lib/critic/manifest";
import { getCriticProvider } from "../../../lib/critic/providers";
import type { BaronessReadiness } from "../../../lib/critic/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

class BodyTooLargeError extends Error {}

/** Read the body as text, refusing anything over `max` bytes without buffering it all. */
async function readBodyLimited(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function GET(): Promise<Response> {
  const provider = getCriticProvider();
  const [critic, manifest] = await Promise.all([provider.readiness(), manifestStatus()]);
  const problems = [...critic.problems];
  const unknown = unknownCriticProvider();
  if (unknown) problems.unshift(`CRITIC_PROVIDER="${unknown}" is not recognised; using ${provider.id}.`);
  if (!manifest.ok && manifest.problem) problems.push(manifest.problem);
  const body: BaronessReadiness = {
    ready: critic.ready && manifest.ok,
    provider: provider.id,
    detail: {
      ...critic.detail,
      timeoutMs: criticTimeoutMs(),
      manifest: manifest.ok,
      manifestReferences: manifest.references,
      fallback: "preset",
    },
    problems,
  };
  return json(body, 200);
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    const text = await readBodyLimited(request, CRITIQUE_MAX_BODY_BYTES);
    payload = JSON.parse(text);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return json({ error: "Request body is too large" }, 413);
    if (request.signal.aborted) return json({ error: "Request aborted" }, 499);
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const outcome = await createCritique(payload, { signal: request.signal });
  if (request.signal.aborted) return json({ error: "Request aborted" }, 499);
  return json(outcome.body, outcome.status);
}
