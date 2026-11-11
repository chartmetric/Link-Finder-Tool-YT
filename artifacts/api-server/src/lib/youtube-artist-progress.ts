import { artistExportObject } from "./artist-result-storage";
import { YOUTUBE_RUN_ID, validateYoutubeArtistProgress } from "./youtube-artist-progress-model";
import type { YoutubeArtistProgress } from "@workspace/api-zod";

const object = () => artistExportObject(`campaign-progress/${YOUTUBE_RUN_ID}.json`);
export function createYoutubeProgressStore(getObject = object) {
  async function read() {
    const file = getObject(), [metadata] = await file.getMetadata();
    if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) > 4096 || !metadata.generation)
      throw Error("YouTube progress exceeds the counter-only limit.");
    const [bytes] = await file.bucket.file(file.name, {generation: metadata.generation}).download({validation: "crc32c"});
    return {value: validateYoutubeArtistProgress(JSON.parse(bytes.toString("utf8"))), generation: metadata.generation};
  }
  return {
    async load(): Promise<YoutubeArtistProgress | null> {
      try { return (await read()).value; }
      catch (e: any) { if (e.code === 404) return null; throw e; }
    },
    async publish(value: YoutubeArtistProgress) {
      const next = validateYoutubeArtistProgress(value);
      let generation: string | number = 0;
      try {
        const prior = await read(); generation = prior.generation;
        if (next.scopeSha256 !== prior.value.scopeSha256 || next.totalArtists !== prior.value.totalArtists
          || next.searchedArtists < prior.value.searchedArtists || next.reservedUsd < prior.value.reservedUsd
          || Date.parse(next.updatedAt) < Date.parse(prior.value.updatedAt)
          || Date.parse(next.capturedAt) < Date.parse(prior.value.capturedAt))
          throw Error("Refusing to replace YouTube progress with an older or different run.");
      } catch (e: any) { if (e.code !== 404) throw e; }
      await getObject().save(JSON.stringify(next), {resumable: false, validation: "crc32c",
        contentType: "application/json", preconditionOpts: {ifGenerationMatch: generation},
        metadata: {cacheControl: "no-store"}});
    },
  };
}
const store = createYoutubeProgressStore();
let cache: {at: number; value: YoutubeArtistProgress | null} | undefined;
export const publishYoutubeProgress = store.publish;
export async function readYoutubeArtistProgress() {
  if (cache && Date.now() - cache.at < 5000) return {progress: cache.value};
  const value = await store.load();
  cache = {at: Date.now(), value};
  return {progress: value};
}
