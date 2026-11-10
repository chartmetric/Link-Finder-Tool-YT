import { test } from "node:test";
import assert from "node:assert/strict";
import { publishArtistDocuments, type ArchiveStore } from "../src/lib/artist-result-publication";
import { nativeArtistDocument } from "../src/lib/artist-result-model";
import type { BulkBrandRun } from "@workspace/api-zod";

const fixture = (id: string) => {
  const doc = nativeArtistDocument({ id, createdAt: "2026-11-10", status: "completed", items: [] } as unknown as BulkBrandRun);
  doc.batch.id = id;
  return doc;
};
function memoryStore() {
  const files = new Map<string, { bytes: Buffer; generation: string }>();
  let generation = 0;
  const store: ArchiveStore = {
    async read(name) { return files.get(name); },
    async create(name, bytes) {
      assert.equal(files.has(name), false);
      files.set(name, { bytes, generation: String(++generation) });
    },
    async writeIndex(bytes, expected) {
      assert.equal(files.get("index.json")?.generation ?? 0, expected);
      files.set("index.json", { bytes, generation: String(++generation) });
    },
  };
  return { store, files };
}
test("additive publication preserves historical documents, summaries and warnings; repeat imports are safe", async () => {
  const { store, files } = memoryStore();
  const old = fixture("historical");
  const original = Buffer.from(JSON.stringify(old));
  await store.create("historical.json", original);
  await store.writeIndex(Buffer.from(JSON.stringify({ batches: [old.batch], warnings: ["historical note"] })), 0);
  const doc = Buffer.from(JSON.stringify(fixture("new-recheck")));
  await publishArtistDocuments([doc], store);
  await publishArtistDocuments([doc], store);
  const index = JSON.parse(files.get("index.json")!.bytes.toString());
  assert.deepEqual(index.batches.map((b: any) => b.id), ["historical", "new-recheck"]);
  assert.deepEqual(index.batches[0], old.batch);
  assert.deepEqual(index.warnings, ["historical note"]);
  assert.equal(files.get("historical.json")!.bytes, original);
  const changed = fixture("historical");
  changed.batch.explanation = "Different decision";
  await assert.rejects(publishArtistDocuments([Buffer.from(JSON.stringify(changed))], store), /Refusing to replace/);
});
test("invalid documents and index races cannot erase existing history", async () => {
  const { store, files } = memoryStore();
  await assert.rejects(publishArtistDocuments([Buffer.from("{}")], store));
  assert.equal(files.size, 0);
  const concurrentStore = { ...store, async writeIndex() { throw Error("generation changed"); } };
  await assert.rejects(publishArtistDocuments([Buffer.from(JSON.stringify(fixture("new")))], concurrentStore), /generation changed/);
  assert.equal(files.has("index.json"), false);
  assert.equal(files.has("new.json"), true); // safely retryable immutable orphan, never a lost history
});
