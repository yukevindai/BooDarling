import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "qrcode";
import { amazonSearchUrl } from "../../lib/critic/aura-max";
import { qrPath } from "./qr";

describe("qrPath", () => {
  it("draws every dark module of the encoded URL, offset by a 4-module quiet zone", () => {
    const url = amazonSearchUrl("red satin halter mermaid gown costume");
    const p = qrPath(url);
    const qr = create(url, { errorCorrectionLevel: "M" });
    assert.equal(p.size, qr.modules.size);
    assert.equal(p.margin, 4);
    const dark = qr.modules.data.reduce((a, b) => a + (b ? 1 : 0), 0);
    assert.equal(p.d.match(/M/g)?.length, dark);
    // Top-left finder pattern starts right after the quiet zone.
    assert.ok(p.d.startsWith("M4 4h1v1h-1z"));
    // Small enough (version <= 5 → <= 37 modules) to scan comfortably at ~120 px.
    assert.ok(p.size <= 37, `size ${p.size}`);
  });
});
