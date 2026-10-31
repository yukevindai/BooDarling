// Copy the MediaPipe Tasks Vision wasm runtime into public/ so the pose model's
// runtime is served by the app itself (same origin), not cdn.jsdelivr.net.
// Venue/corporate networks sometimes block CDNs; without the runtime, presence
// detection and automatic capture never start. Runs before `dev` and `build`.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join(root, "public", "mediapipe", "wasm");

if (!existsSync(src)) {
  console.warn("[mediapipe] node_modules/@mediapipe/tasks-vision/wasm not found; run npm install first.");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("[mediapipe] wasm runtime copied to public/mediapipe/wasm");
