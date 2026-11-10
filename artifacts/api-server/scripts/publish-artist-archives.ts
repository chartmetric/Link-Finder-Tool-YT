// Explicit local publication of frozen report assets. Never called from HTTP.
import fs from "node:fs/promises";
import path from "node:path";
import { artistExportObject } from "../src/lib/artist-result-storage";
import { publishArtistDocuments } from "../src/lib/artist-result-publication";

const directory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Pass the prepared archive directory.");
const index = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
if (process.argv.includes("--index-only")) {
  throw Error("Index-only replacement is disabled. Import complete immutable documents to extend history safely.");
}
const documents: Buffer[] = [];
for (const batch of index.batches) {
  if (!/^[a-z0-9-]+$/.test(batch.id)) throw Error("Invalid fixed archive id.");
  documents.push(await fs.readFile(path.join(directory, `${batch.id}.json`)));
}
const batches = await publishArtistDocuments(documents, {
  async read(name) {
    const object = artistExportObject(name);
    try {
      const [meta] = await object.getMetadata();
      const [bytes] = await object.bucket.file(object.name, { generation: String(meta.generation) }).download();
      return { bytes, generation: String(meta.generation) };
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
  },
  async create(name, bytes) {
    await artistExportObject(name).save(bytes, { resumable: false, gzip: true,
      metadata: { contentType: "application/json" }, preconditionOpts: { ifGenerationMatch: 0 } });
  },
  async writeIndex(bytes, generation) {
    await artistExportObject("index.json").save(bytes, { resumable: false,
      metadata: { contentType: "application/json" }, preconditionOpts: { ifGenerationMatch: generation } });
  },
});
for (const b of batches) console.log(`${b.id}: ${b.artistCount} artists, ${b.rowCount} rows stored`);
console.log("Saved batch index extended; previous archives and summaries preserved.");
