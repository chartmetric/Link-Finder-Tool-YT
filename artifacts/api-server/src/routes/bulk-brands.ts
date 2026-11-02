import { Router, type IRouter, type Request, type Response } from "express";
import {
  ListBulkBrandCandidatesQueryParams, ListBulkBrandCandidatesResponse,
  ListBulkBrandRunsResponse, StartBulkBrandRunBody, ResumeBulkBrandRunBody, GetBulkBrandRunResponse, ListBulkRunBatchesResponse,
} from "@workspace/api-zod";
import { listEligibleBrands } from "../lib/bulk-brand-candidates";
import { readBulkBatchArchives, readBulkRuns } from "../lib/bulk-run-store";
import { BulkError, getBulkRun, resumeBulkRun, startBulkRun, stopBulkRun } from "../lib/bulk-brand-runner";
import { validateBulkSelection } from "../lib/bulk-profile-scopes";
import { getBulkCoverage } from "../lib/bulk-coverage";

const router: IRouter = Router();
router.get("/bulk/coverage", async (req, res) => {
  try { res.json(await getBulkCoverage()); }
  catch (error) { respondError(req, res, error); }
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function respondError(req: Request, res: Response, error: unknown) {
  req.log.error({ err: error }, "Bulk request failed");
  res.status(error instanceof BulkError ? error.status : 503).json({
    error: error instanceof Error ? error.message : "Bulk processing is unavailable.",
  });
}
router.get("/bulk/brands/candidates", async (req, res) => {
  // Express permits repeated and structured query parameters; codegen coerces
  // strings/numbers, so reject non-scalar values before generated validation.
  if (["limit", "afterId", "profileType", "search", "tier"].some(key =>
    req.query[key] !== undefined && typeof req.query[key] !== "string")) {
    res.status(400).json({ error: "Candidate filters must each be a single query value." }); return;
  }
  const params = ListBulkBrandCandidatesQueryParams.safeParse(req.query);
  if (!params.success || !Number.isSafeInteger(params.data.limit ?? 10)
    || !Number.isSafeInteger(params.data.afterId ?? 0)) {
    res.status(400).json({ error: "Use a valid profile type, a search of at most 120 characters, a tier from 1–5, an integer page size from 1–25 and a valid page cursor." }); return;
  }
  try {
    res.json(ListBulkBrandCandidatesResponse.parse(await listEligibleBrands({
      limit: params.data.limit ?? 10, afterId: params.data.afterId ?? 0, profileType: params.data.profileType,
      search: params.data.search, tier: params.data.tier,
    })));
  } catch (error) { respondError(req, res, error); }
});
router.get("/bulk/brands/runs", async (req, res) => {
  try { res.json(ListBulkBrandRunsResponse.parse({ runs: await readBulkRuns() })); }
  catch (error) { respondError(req, res, error); }
});
router.post("/bulk/brands/runs", async (req, res) => {
  const body = StartBulkBrandRunBody.safeParse(req.body);
  if (!body.success || !uuid.test(body.data.requestId)) {
    res.status(400).json({ error: "Select valid profiles or scopes and a valid request ID." }); return;
  }
  const selectionError = validateBulkSelection(body.data);
  if (selectionError) { res.status(400).json({ error: selectionError }); return; }
  try { res.json(GetBulkBrandRunResponse.parse(await startBulkRun(body.data.requestId, body.data))); }
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
router.get("/bulk/brands/runs/:runId/batches/:afterBatch", async (req, res) => {
  const cursor = Number(req.params.afterBatch);
  if (!uuid.test(req.params.runId) || !Number.isSafeInteger(cursor) || cursor < 0) {
    res.status(400).json({ error: "Use a valid run ID and non-negative integer batch cursor." }); return;
  }
  try {
    const run = await getBulkRun(req.params.runId);
    if (!run) { res.status(404).json({ error: "Bulk run not found." }); return; }
    res.json(ListBulkRunBatchesResponse.parse(await readBulkBatchArchives(req.params.runId, cursor)));
  } catch (error) { respondError(req, res, error); }
});
for (const action of ["stop", "resume"] as const) router.post(`/bulk/brands/runs/:runId/${action}`, async (req, res) => {
  if (!uuid.test(req.params.runId)) { res.status(400).json({ error: "Invalid run ID." }); return; }
  const body = action === "resume" ? ResumeBulkBrandRunBody.safeParse(req.body) : undefined;
  if (body && (!body.success || !uuid.test(body.data.requestId))) {
    res.status(400).json({ error: "Use a valid request ID to resume this run safely." }); return;
  }
  try {
    const run = await (body?.success ? resumeBulkRun(req.params.runId, body.data) : stopBulkRun(req.params.runId));
    res.json(GetBulkBrandRunResponse.parse(run));
  } catch (error) { respondError(req, res, error); }
});
export default router;
