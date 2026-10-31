/**
 * GET /api/reference/:referenceId -> 302 to the reference image's public URL.
 *
 * The results screen only knows `referenceId` (from RateResult). R3's manifest
 * (references/manifest.json) maps it to an image under `public/`, so resolve it
 * server-side and redirect to the static file. 404 for unknown ids or images
 * that are not served from `public/`.
 */
import path from "node:path";
import { projectRoot } from "../../../../lib/critic/config";
import { isInsideRoot } from "../../../../lib/critic/images";
import { resolveReference } from "../../../../lib/critic/manifest";
import { isValidSessionId } from "../../../../lib/critic/session-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function notFound(): Response {
  return Response.json({ error: "Unknown reference" }, { status: 404, headers: NO_STORE });
}

export async function GET(_req: Request, { params }: { params: { referenceId: string } }): Promise<Response> {
  const referenceId = params.referenceId;
  // Same rule as session ids: non-empty, <= 128 printable ASCII characters.
  if (!isValidSessionId(referenceId)) {
    return Response.json({ error: "Invalid referenceId" }, { status: 400, headers: NO_STORE });
  }

  const ref = await resolveReference(referenceId);
  if (!ref) return notFound();

  const publicDir = path.join(projectRoot(), "public");
  if (!isInsideRoot(publicDir, ref.imagePath)) return notFound();
  const rel = path.relative(publicDir, ref.imagePath).split(path.sep);
  if (rel.length === 0 || rel[0] === "") return notFound();
  const location = "/" + rel.map(encodeURIComponent).join("/");

  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });
}
