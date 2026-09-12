import { Router, type IRouter } from "express";
import {
  ListExistingProfilesQueryParams,
  ListExistingProfilesResponse,
  SearchProfilesBody,
  SearchProfilesResponse,
} from "@workspace/api-zod";
import { findProfiles } from "../lib/musician-search";
import { listExistingProfiles } from "../lib/clickhouse-profiles";

const router: IRouter = Router();

router.get("/profiles", async (req, res): Promise<void> => {
  const input = ListExistingProfilesQueryParams.safeParse(req.query);
  if (!input.success) {
    res.status(400).json({ error: "Invalid profile list parameters." });
    return;
  }

  const query = input.data.query ?? "";
  const page = input.data.page ?? 1;
  const limit = input.data.limit ?? 25;

  try {
    const result = await listExistingProfiles({ query, page, limit });
    res.json(
      ListExistingProfilesResponse.parse({
        ...result,
        page,
        limit,
        query,
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Existing profile list failed");
    res.status(503).json({ error: "Profile database is temporarily unavailable." });
  }
});

router.post("/profiles/search", async (req, res): Promise<void> => {
  const input = SearchProfilesBody.safeParse(req.body);
  if (!input.success) {
    req.log.warn({ errors: input.error.message }, "Invalid profile search");
    res.status(400).json({ error: "Enter a name, a known social handle, or both." });
    return;
  }
  if (!input.data.subject?.trim() && !input.data.handle?.trim()) {
    req.log.warn("Profile search missing both name and handle");
    res.status(400).json({ error: "Enter a name, a known social handle, or both." });
    return;
  }

  try {
    const result = await findProfiles({
      ...input.data,
      serperApiKey: process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
      tavilyApiKey: process.env.TAVILY_WEB_SEARCH_API_KEY,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      scrapeCreatorsApiKey: process.env.SCRAPECREATORS_API_KEY,
      socialCrawlApiKey: process.env.SOCIALCRAWL_API_KEY,
    });
    res.json(SearchProfilesResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Profile search failed");
    res.status(502).json({
      error: "Google search is temporarily unavailable. Please try again.",
    });
  }
});

export default router;