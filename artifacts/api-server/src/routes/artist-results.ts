import { Router } from "express";
import { GetArtistCampaignProgressResponse, GetYoutubeArtistProgressResponse, GetArtistResultRowsParams, GetArtistResultRowsResponse, ListArtistResultBatchesResponse } from "@workspace/api-zod";
import { readArtistCampaignProgress } from "../lib/artist-campaign-progress";
import { artistResultDocument, listArtistResults } from "../lib/artist-results";
import { paginateResults, resultCsv } from "../lib/artist-result-model";
import { readYoutubeArtistProgress } from "../lib/youtube-artist-progress";
import { youtubeResultId, youtubeResultsPage, youtubeResultsExport } from "../lib/youtube-campaign-results";

const router = Router();
// Never cache current conflict projection, including downloadable exports.
router.use("/bulk/artist-results", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get("/bulk/youtube-artist-progress", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(GetYoutubeArtistProgressResponse.parse(await readYoutubeArtistProgress())); }
  catch (error) {
    req.log.error({err: error}, "Saved YouTube progress unavailable");
    res.status(503).json({error: "Saved YouTube progress is unavailable. No paid work was started or retried."});
  }
});
router.get("/bulk/artist-campaign-progress", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(GetArtistCampaignProgressResponse.parse(await readArtistCampaignProgress())); }
  catch (error) {
    req.log.error({ err: error }, "Artist campaign progress unavailable");
    res.status(503).json({ error: "Progress is temporarily unavailable. No paid work was started or retried." });
  }
});
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(id);
router.get("/bulk/artist-results", async (req, res) => {
  try { res.json(ListArtistResultBatchesResponse.parse(await listArtistResults())); }
  catch (error) { req.log.error({ err: error }, "Artist batch list unavailable"); res.status(503).json({ error: "Could not load saved batch results. No paid work was started." }); }
});
router.get("/bulk/artist-results/:batchId/rows/:offset/:pageSize/:searchTerm/:resultFilter", async (req, res) => {
  const parsed = GetArtistResultRowsParams.safeParse(req.params);
  if (!parsed.success || !validId(parsed.data.batchId) || !parsed.data.searchTerm.startsWith("q:")
    || !Number.isSafeInteger(parsed.data.offset) || !Number.isSafeInteger(parsed.data.pageSize)) {
    res.status(400).json({ error: "Use a valid batch, search, filter and integer page cursor." }); return;
  }
  try {
    if (parsed.data.batchId === youtubeResultId) {
      const page = await youtubeResultsPage(parsed.data.offset, parsed.data.pageSize, parsed.data.searchTerm.slice(2), parsed.data.resultFilter);
      if (!page) { res.status(404).json({ error: "YouTube campaign not found." }); return; }
      res.json(GetArtistResultRowsResponse.parse(page)); return;
    }
    const doc = await artistResultDocument(parsed.data.batchId);
    if (!doc) { res.status(404).json({ error: "Saved batch not found." }); return; }
    res.json(GetArtistResultRowsResponse.parse(paginateResults(doc, parsed.data.offset, parsed.data.pageSize,
      parsed.data.searchTerm.slice(2), parsed.data.resultFilter)));
  } catch (error) {
    req.log.error({ err: error }, "Artist batch detail unavailable");
    res.status(503).json({ error: "This batch's saved evidence could not be loaded. Refresh to retry." });
  }
});
router.get("/bulk/artist-results/:batchId/csv", async (req, res) => {
  if (!validId(req.params.batchId)) { res.status(400).json({ error: "Invalid batch." }); return; }
  try {
    if (req.params.batchId === youtubeResultId) {
      // Both coordinator selection and archive reads are bounded. The first
      // chunk can be sent without reading the rest of the campaign.
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${youtubeResultId}-findings.csv"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      let first = true;
      for await (const doc of youtubeResultsExport()) {
        if (res.destroyed) return;
        const csv = resultCsv(doc);
        const chunk = first ? "\uFEFF" + csv : csv.slice(csv.indexOf("\r\n") + 2);
        first = false;
        if (!res.write(chunk)) {
          await new Promise<void>(resolve => {
            const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); };
            res.once("drain", finish); res.once("close", finish);
          });
        }
      }
      res.end(); return;
    }
    const doc = await artistResultDocument(req.params.batchId);
    if (!doc) { res.status(404).json({ error: "Saved batch not found." }); return; }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.batch.id}-findings.csv"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send("\uFEFF" + resultCsv(doc));
  } catch (error) {
    req.log.error({ err: error }, "Artist batch CSV unavailable");
    if (res.headersSent) { res.destroy(); return; }
    res.removeHeader("Content-Disposition");
    res.status(503).json({ error: "The saved CSV could not be exported." });
  }
});
export default router;
