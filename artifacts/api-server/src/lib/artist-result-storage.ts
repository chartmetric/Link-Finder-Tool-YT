import { Storage } from "@google-cloud/storage";
import type { BatchDocument } from "./artist-result-model";
import { GetArtistResultRowsResponse, ListArtistResultBatchesResponse } from "@workspace/api-zod";
import { normalizeExportDocument } from "./artist-result-model";

const client = new Storage({ projectId: "", credentials: {
  audience: "replit", subject_token_type: "access_token", token_url: "http://127.0.0.1:1106/token",
  type: "external_account", credential_source: { url: "http://127.0.0.1:1106/credential",
    format: { type: "json", subject_token_field_name: "access_token" } }, universe_domain: "googleapis.com",
} });
const prefix = "artist-batch-exports/v1";
export function artistExportObject(name: string) {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucket) throw Error("Saved batch export storage is not configured.");
  return client.bucket(bucket).file(`${prefix}/${name}`);
}
async function json(name: string) {
  const object = artistExportObject(name);
  const [meta] = await object.getMetadata();
  if (Number(meta.size) > 40 * 1024 * 1024) throw Error("Saved export exceeds the bounded archive size.");
  const [data] = await object.download({ validation: "crc32c" });
  return JSON.parse(data.toString("utf8"));
}
let indexCache: { at: number; value: Awaited<ReturnType<typeof readIndex>> } | undefined;
async function readIndex() {
  return ListArtistResultBatchesResponse.parse(await json("index.json"));
}
export async function storedArtistBatches() {
  if (indexCache && Date.now() - indexCache.at < 30_000) return indexCache.value;
  const value = await readIndex(); indexCache = { at: Date.now(), value }; return value;
}
const documents = new Map<string, { at: number; doc: BatchDocument }>();
export async function storedArtistDocument(id: string): Promise<BatchDocument | undefined> {
  if (!(await storedArtistBatches()).batches.some(b => b.id === id)) return undefined;
  const cached = documents.get(id);
  if (cached && Date.now() - cached.at < 60_000) return cached.doc;
  const data = await json(`${id}.json`);
  const parsed = GetArtistResultRowsResponse.parse({ ...data, total: data.rows?.length, nextOffset: null });
  if (parsed.batch.id !== id) throw Error("Archive identity does not match the selected batch.");
  // This display classification is derived from the original field text;
  // retain every original field and model decision unchanged.
  const doc = normalizeExportDocument({ batch: parsed.batch, rows: parsed.rows });
  if (documents.size >= 3) documents.delete(documents.keys().next().value!);
  documents.set(id, { at: Date.now(), doc }); return doc;
}
