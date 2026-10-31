import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCritiqueRequest } from "./critique";
import { isValidSessionId } from "./session-id";
import { validateSpeechRequest } from "./speech";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const DATA_URL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;

function critiqueBody(sessionId: unknown) {
  return {
    capture: { sessionId, outfitImage: DATA_URL },
    result: { status: "ok", sessionId, aura: 50, lookId: "l", referenceId: "r", similarity: 0.5, referenceScores: [] },
  };
}

const VALID = ["s1", "3f2c1a9e-7b1d-4c55-9e0a-0d7a1b2c3d4e", "visitor_42:a.b", "s".repeat(128)];
const INVALID: unknown[] = [
  undefined,
  null,
  5,
  "",
  "   ",
  "s".repeat(129),
  "a\nb",
  "sess\r\nX-Evil: 1",
  "a\u0000b",
  "a\u007fb",
  "café",
  "セッション",
  "emoji-\u{1F480}",
];

describe("shared sessionId rule (critique + speech)", () => {
  it("accepts printable ASCII ids up to 128 chars", () => {
    for (const id of VALID) assert.equal(isValidSessionId(id), true, id);
  });

  it("rejects empty, too long, control, CR/LF and non-ASCII ids (header-unsafe)", () => {
    for (const id of INVALID) assert.equal(isValidSessionId(id), false, JSON.stringify(id));
  });

  it("speech and critique validation agree on every id", () => {
    for (const id of [...VALID, ...INVALID]) {
      const speech = validateSpeechRequest({ sessionId: id, text: "Hello there." }).ok;
      const critique = validateCritiqueRequest(critiqueBody(id)).ok;
      assert.equal(speech, critique, JSON.stringify(id));
      assert.equal(speech, isValidSessionId(id), JSON.stringify(id));
    }
  });
});
