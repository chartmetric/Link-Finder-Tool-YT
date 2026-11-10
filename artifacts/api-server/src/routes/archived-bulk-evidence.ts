import { Router, type IRouter } from "express";
import { ListArchivedBulkEvidenceQueryParams, ListArchivedBulkEvidenceResponse } from "@workspace/api-zod";
import { readArchivedBulkEvidence } from "../lib/archived-bulk-evidence";

const router: IRouter = Router();
router.get("/investigations/bulk-evidence", async (req,res): Promise<void> => {
  const parsed = ListArchivedBulkEvidenceQueryParams.safeParse(req.query);
  if (!parsed.success || !Number.isSafeInteger(parsed.data.page ?? 1)) {
    res.status(400).json({error:"Choose a valid archive and whole page number."}); return;
  }
  try { res.json(ListArchivedBulkEvidenceResponse.parse(await readArchivedBulkEvidence(parsed.data.archive,parsed.data.page??1))); }
  catch (error) {
    if ((error as Error).message === "INVALID_ARCHIVE") { res.status(400).json({error:"Saved archive not found."}); return; }
    req.log.error({err:error},"Could not read archived bulk evidence");
    res.status(503).json({error:"Saved bulk evidence could not be read. No lookup was run. Retry after archive storage is available."});
  }
});
export default router;
