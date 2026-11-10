import { createHash } from "node:crypto";
import { GetArtistResultRowsResponse, ListArtistResultBatchesResponse } from "@workspace/api-zod";
import type { ArtistResultBatch } from "@workspace/api-zod";

export type ArchiveStore = {
  read(name: string): Promise<{ bytes: Buffer; generation: string } | undefined>;
  create(name: string, bytes: Buffer): Promise<void>;
  writeIndex(bytes: Buffer, generation: string | 0): Promise<void>;
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Add immutable documents before atomically extending the index. Never drop history. */
export async function publishArtistDocuments(documents: Buffer[], store: ArchiveStore) {
  const batches: ArtistResultBatch[] = [];
  const ids = new Set<string>();
  // Validate the entire input before writing anything.
  for (const bytes of documents) {
    if (bytes.length > 40 * 1024 * 1024) throw Error("Archive exceeds bounded size.");
    const data = JSON.parse(bytes.toString("utf8"));
    const doc = GetArtistResultRowsResponse.parse({ ...data, total: data.rows?.length, nextOffset: null });
    if (!/^[a-z0-9-]+$/.test(doc.batch.id) || ids.has(doc.batch.id)) throw Error("Invalid or duplicate archive identity.");
    ids.add(doc.batch.id);
    if (doc.batch.rowCount !== doc.rows.length) throw Error("Archive row count differs from its summary.");
    batches.push(doc.batch);
  }
  for (const [i, batch] of batches.entries()) {
    const name = `${batch.id}.json`, old = await store.read(name);
    if (old) {
      if (hash(old.bytes) !== hash(documents[i])) throw Error(`Refusing to replace frozen archive ${batch.id}`);
    } else {
      await store.create(name, documents[i]);
    }
  }
  const oldIndex = await store.read("index.json");
  const previous = oldIndex ? ListArtistResultBatchesResponse.parse(JSON.parse(oldIndex.bytes.toString("utf8")))
    : { batches: [], warnings: [] };
  // Existing summaries are preserved too; an idempotent import cannot reclassify history.
  const merged = [...previous.batches, ...batches.filter(b => !previous.batches.some(old => old.id === b.id))];
  const next = ListArtistResultBatchesResponse.parse({ batches: merged, warnings: previous.warnings });
  await store.writeIndex(Buffer.from(JSON.stringify(next)), oldIndex?.generation ?? 0);
  return batches;
}
