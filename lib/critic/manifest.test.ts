import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadReferenceImage, parseImageDataUrl, sniffImageMime } from "./images";
import {
  clearManifestCache,
  humaniseLookId,
  imagePathCandidates,
  manifestStatus,
  parseManifest,
  resolveReference,
} from "./manifest";
import { OUTFIT_IMAGE_MAX_BYTES } from "./types";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let outside: string;
const saved = { root: process.env.REFLECT_PROJECT_ROOT, manifest: process.env.REFERENCES_MANIFEST_PATH };

async function writeManifest(json: unknown, when?: Date) {
  const p = path.join(root, "references", "manifest.json");
  await writeFile(p, JSON.stringify(json));
  if (when) await utimes(p, when, when);
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reflect-manifest-"));
  outside = await mkdtemp(path.join(tmpdir(), "reflect-outside-"));
  await mkdir(path.join(root, "references", "img"), { recursive: true });
  await mkdir(path.join(root, "public", "references", "cruella", "classic-dalmatian"), { recursive: true });
  await writeFile(path.join(root, "public", "references", "cruella", "classic-dalmatian", "01.jpg"), JPEG);
  await writeFile(path.join(root, "public", "references", "cruella", "classic-dalmatian", "02.png"), PNG);
  await writeFile(path.join(root, "references", "img", "03.jpg"), JPEG);
  await writeFile(path.join(outside, "secret.jpg"), JPEG);
  await symlink(path.join(outside, "secret.jpg"), path.join(root, "public", "references", "link.jpg"));
  process.env.REFLECT_PROJECT_ROOT = root;
  delete process.env.REFERENCES_MANIFEST_PATH;
});

after(async () => {
  if (saved.root === undefined) delete process.env.REFLECT_PROJECT_ROOT;
  else process.env.REFLECT_PROJECT_ROOT = saved.root;
  if (saved.manifest !== undefined) process.env.REFERENCES_MANIFEST_PATH = saved.manifest;
  clearManifestCache();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

beforeEach(() => clearManifestCache());

describe("manifest", () => {
  it("humanises look ids", () => {
    assert.equal(humaniseLookId("classic-dalmatian"), "Classic Dalmatian");
    assert.equal(humaniseLookId("red_ball-gown"), "Red Ball Gown");
  });

  it("resolves the looks[] schema with public/ paths and look metadata", async () => {
    await writeManifest({
      looks: [
        {
          lookId: "classic-dalmatian",
          label: "Classic Dalmatian Coat",
          description: "Spotted coat, red gloves.",
          references: [
            { referenceId: "cd-01", imagePath: "public/references/cruella/classic-dalmatian/01.jpg", description: "per-image" },
            { referenceId: "cd-02", image: "/references/cruella/classic-dalmatian/02.png" },
          ],
        },
      ],
    });
    const r1 = await resolveReference("cd-01");
    assert.deepEqual(r1, {
      referenceId: "cd-01",
      lookId: "classic-dalmatian",
      lookLabel: "Classic Dalmatian Coat",
      lookDescription: "Spotted coat, red gloves.",
      imagePath: path.join(root, "public", "references", "cruella", "classic-dalmatian", "01.jpg"),
    });
    const r2 = await resolveReference("cd-02");
    assert.equal(r2?.imagePath, path.join(root, "public", "references", "cruella", "classic-dalmatian", "02.png"));
  });

  it("resolves a top-level array and {references: []} with fallback labels", async () => {
    await writeManifest([{ referenceId: "a", lookId: "classic-dalmatian", path: "references/img/03.jpg" }]);
    const a = await resolveReference("a");
    assert.equal(a?.lookLabel, "Classic Dalmatian");
    assert.equal(a?.imagePath, path.join(root, "references", "img", "03.jpg"));

    await writeManifest(
      {
        references: [{ referenceId: "b", lookId: "punk-look", file: "references/cruella/classic-dalmatian/01.jpg", description: "Desc B" }],
        looks: { "punk-look": { name: "Punk Look" } },
      },
      new Date(Date.now() + 5000),
    );
    const b = await resolveReference("b");
    // "references/..." is not under root/references/cruella, so the public/ variant is used.
    assert.equal(b?.imagePath, path.join(root, "public", "references", "cruella", "classic-dalmatian", "01.jpg"));
    assert.equal(b?.lookLabel, "Punk Look");
    assert.equal(b?.lookDescription, "Desc B");
  });

  it("uses the RateResult lookId only as a fallback", async () => {
    await writeManifest({ references: [{ referenceId: "x", src: "references/img/03.jpg" }] });
    const x = await resolveReference("x", "red-gown");
    assert.equal(x?.lookId, "red-gown");
    assert.equal(x?.lookLabel, "Red Gown");
  });

  it("returns null for unknown ids, missing files, remote URLs and escaping paths", async () => {
    await writeManifest({
      references: [
        { referenceId: "missing", imagePath: "public/references/nope.jpg" },
        { referenceId: "remote", imagePath: "https://example.com/a.jpg" },
        { referenceId: "escape", imagePath: "../../../etc/passwd" },
        { referenceId: "abs", imagePath: path.join(outside, "secret.jpg") },
        { referenceId: "noimage" },
      ],
    });
    for (const id of ["unknown", "missing", "remote", "escape", "abs", "noimage"]) {
      assert.equal(await resolveReference(id), null, id);
    }
  });

  it("reloads when the manifest mtime changes", async () => {
    await writeManifest({ references: [{ referenceId: "r", lookId: "one", imagePath: "references/img/03.jpg" }] }, new Date(1_000_000));
    assert.equal((await resolveReference("r"))?.lookId, "one");
    await writeManifest({ references: [{ referenceId: "r", lookId: "two", imagePath: "references/img/03.jpg" }] }, new Date(2_000_000));
    assert.equal((await resolveReference("r"))?.lookId, "two");
  });

  it("reports manifest status and never throws on bad JSON or a missing file", async () => {
    await writeManifest({ looks: [] }, new Date(3_000_000));
    assert.equal((await manifestStatus()).ok, false);
    await writeFile(path.join(root, "references", "manifest.json"), "{not json");
    assert.equal(await resolveReference("r"), null);
    assert.match((await manifestStatus()).problem ?? "", /parsed/);
    process.env.REFERENCES_MANIFEST_PATH = "references/does-not-exist.json";
    try {
      assert.equal(await resolveReference("r"), null);
      const st = await manifestStatus();
      assert.equal(st.ok, false);
      assert.match(st.problem ?? "", /not found/);
    } finally {
      delete process.env.REFERENCES_MANIFEST_PATH;
    }
  });

  it("parses the local harness manifest shape", () => {
    const { entries } = parseManifest({
      version: "v0",
      looks: [{ lookId: "classic-dalmatian", label: "L", references: [{ referenceId: "classic-dalmatian-01", imagePath: "p.jpg" }] }],
    });
    assert.equal(entries.get("classic-dalmatian-01")?.lookLabel, "L");
  });

  it("only yields image path candidates inside the root", () => {
    assert.deepEqual(imagePathCandidates("../../x.jpg", root), []);
    assert.deepEqual(imagePathCandidates("http://a/b.jpg", root), []);
    assert.deepEqual(imagePathCandidates("/references/a.jpg?v=1", root), [path.join(root, "public", "references", "a.jpg")]);
  });
});

describe("images", () => {
  it("sniffs magic bytes", () => {
    assert.equal(sniffImageMime(JPEG), "image/jpeg");
    assert.equal(sniffImageMime(PNG), "image/png");
    assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("hello")), null);
  });

  it("parses a JPEG data URL", () => {
    const r = parseImageDataUrl(`data:image/jpeg;base64,${JPEG.toString("base64")}`);
    assert.ok(r.ok);
    assert.equal(r.image.mimeType, "image/jpeg");
    assert.equal(r.image.base64, JPEG.toString("base64"));
  });

  it("rejects non-data URLs, wrong types, fake bytes and oversized images", () => {
    assert.equal(parseImageDataUrl("https://x/y.jpg").ok, false);
    assert.equal(parseImageDataUrl(`data:image/gif;base64,${JPEG.toString("base64")}`).ok, false);
    assert.equal(parseImageDataUrl(`data:image/jpeg;base64,${Buffer.from("not an image").toString("base64")}`).ok, false);
    assert.equal(parseImageDataUrl("data:image/jpeg;base64,").ok, false);
    assert.equal(parseImageDataUrl(123).ok, false);
    const big = Buffer.concat([JPEG, Buffer.alloc(OUTFIT_IMAGE_MAX_BYTES)]);
    assert.equal(parseImageDataUrl(`data:image/jpeg;base64,${big.toString("base64")}`).ok, false);
  });

  it("loads reference images inside the root only (including via symlinks)", async () => {
    const img = await loadReferenceImage(path.join(root, "references", "img", "03.jpg"), root);
    assert.equal(img.mimeType, "image/jpeg");
    await assert.rejects(loadReferenceImage(path.join(outside, "secret.jpg"), root), /escapes/);
    await assert.rejects(loadReferenceImage(path.join(root, "public", "references", "link.jpg"), root), /escapes/);
    await assert.rejects(loadReferenceImage(path.join(root, "references", "manifest.json"), root), /unsupported/);
  });
});
