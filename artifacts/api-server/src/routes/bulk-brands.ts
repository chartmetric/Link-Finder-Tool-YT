import { Router, type IRouter, type Request, type Response } from "express";
import {
  ListBulkBrandCandidatesQueryParams, ListBulkBrandCandidatesResponse,
  ListBulkBrandRunsResponse, StartBulkBrandRunBody, GetBulkBrandRunResponse,
} from "@workspace/api-zod";
import { listEligibleBrands } from "../lib/bulk-brand-candidates";
import { readBulkRuns } from "../lib/bulk-run-store";
import { BulkError, getBulkRun, resumeBulkRun, startBulkRun, stopBulkRun } from "../lib/bulk-brand-runner";

const router: IRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function respondError(req: Request, res: Response, error: unknown) {
  req.log.error({ err: error }, "Bulk request failed");
  res.status(error instanceof BulkError ? error.status : 503).json({
    error: error instanceof Error ? error.message : "Bulk processing is unavailable.",
  });
}
router.get("/bulk/brands/candidates", async (req, res) => {
  const params = ListBulkBrandCandidatesQueryParams.safeParse(req.query);
  if (!params.success || !Number.isSafeInteger(params.data.limit ?? 10)
    || !Number.isSafeInteger(params.data.afterId ?? 0)) {
    res.status(400).json({ error: "Use an integer batch size from 1–25 and a valid page cursor." }); return;
  }
  try {
    res.json(ListBulkBrandCandidatesResponse.parse(await listEligibleBrands({
      limit: params.data.limit ?? 10, afterId: params.data.afterId ?? 0,
    })));
  } catch (error) { respondError(req, res, error); }
});
router.get("/bulk/brands/runs", async (req, res) => {
  try { res.json(ListBulkBrandRunsResponse.parse({ runs: await readBulkRuns() })); }
  catch (error) { respondError(req, res, error); }
});
router.post("/bulk/brands/runs", async (req, res) => {
  const body = StartBulkBrandRunBody.safeParse(req.body);
  if (!body.success || !uuid.test(body.data.requestId)
    || !body.data.profileIds.every(id => Number.isSafeInteger(id))
    || new Set(body.data.profileIds).size !== body.data.profileIds.length) {
    res.status(400).json({ error: "Select 1–25 distinct valid brand IDs and a valid request ID." }); return;
  }
  try { res.json(GetBulkBrandRunResponse.parse(await startBulkRun(body.data.requestId, body.data.profileIds))); }
  catch (error) { respondError(req, res, error); }
});
router.get("/bulk/brands/runs/:runId", async (req, res) => {
  if (!uuid.test(req.params.runId)) { res.status(400).json({ error: "Invalid run ID." }); return; }
  try {
    const run = await getBulkRun(req.params.runId);
    if (!run) { res.status(404).json({ error: "Bulk run not found." }); return; }
    res.json(GetBulkBrandRunResponse.parse(run));
  } catch (error) { respondError(req, res, error); }
});
for (const action of ["stop", "resume"] as const) router.post(`/bulk/brands/runs/:runId/${action}`, async (req, res) => {
  if (!uuid.test(req.params.runId)) { res.status(400).json({ error: "Invalid run ID." }); return; }
  try {
    const run = await (action === "stop" ? stopBulkRun(req.params.runId) : resumeBulkRun(req.params.runId));
    res.json(GetBulkBrandRunResponse.parse(run));
  } catch (error) { respondError(req, res, error); }
});
export default router;
