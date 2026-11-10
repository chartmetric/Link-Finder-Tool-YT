// Explicit local publication of frozen report assets. Never called from HTTP.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { artistExportObject } from "../src/lib/artist-result-storage";

const directory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Pass the prepared archive directory.");
const index = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
if (process.argv.includes("--index-only")) {
  // Refresh derived summary counts without replacing any frozen source rows.
  await artistExportObject("index.json").save(await fs.readFile(path.join(directory, "index.json")),
    { resumable: false, metadata: { contentType: "application/json" } });
  console.log("Derived batch index refreshed; frozen result objects unchanged.");
  process.exit(0);
}
for (const batch of index.batches) {
  if (!/^[a-z0-9-]+$/.test(batch.id)) throw Error("Invalid fixed archive id.");
  const bytes = await fs.readFile(path.join(directory, `${batch.id}.json`));
  const object = artistExportObject(`${batch.id}.json`);
  if ((await object.exists())[0]) {
    const [old] = await object.download();
    if (createHash("sha256").update(old).digest("hex") !== createHash("sha256").update(bytes).digest("hex"))
      throw Error(`Refusing to replace frozen archive ${batch.id}`);
  } else {
    await object.save(bytes, { resumable: false, gzip: true,
      metadata: { contentType: "application/json" }, preconditionOpts: { ifGenerationMatch: 0 } });
  }
  console.log(`${batch.id}: ${batch.artistCount} artists, ${batch.rowCount} rows stored`);
}
await artistExportObject("index.json").save(await fs.readFile(path.join(directory, "index.json")),
  { resumable: false, metadata: { contentType: "application/json" } });
console.log("Saved batch export index published.");
