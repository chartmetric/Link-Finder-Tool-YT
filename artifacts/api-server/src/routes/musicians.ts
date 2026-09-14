import { Router, type IRouter } from "express";
import {
  ApproveProfileSuggestionsBody,
  ApproveProfileSuggestionsParams,
  ApproveProfileSuggestionsResponse,
  ListExistingProfilesQueryParams,
  ListExistingProfilesResponse,
  SearchProfilesBody,
  SearchProfilesResponse,
} from "@workspace/api-zod";
import { findProfiles } from "../lib/musician-search";
import {
  approveProfileSuggestions,
  listExistingProfiles,
} from "../lib/clickhouse-profiles";

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
  const tier = input.data.tier;
  const sortBy = input.data.sortBy ?? "tier_rank";
  const sortDirection = input.data.sortDirection ?? "asc";

  try {
    const result = await listExistingProfiles({
      query,
      page,
      limit,
      tier,
      sortBy,
      sortDirection,
    });
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

router.post("/profiles/:profileId/suggestions", async (req, res): Promise<void> => {
  const params = ApproveProfileSuggestionsParams.safeParse(req.params);
  const body = ApproveProfileSuggestionsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid profile suggestions." });
    return;
  }

  try {
    const result = await approveProfileSuggestions({
      profileId: params.data.profileId,
      profileName: body.data.profileName,
      suggestions: body.data.suggestions,
    });
    res.json(ApproveProfileSuggestionsResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Profile suggestion approval failed");
    res.status(503).json({
      error: "Suggestion storage is unavailable. ClickHouse permissions may need to be updated.",
    });
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

  const timeoutMs = 60_000;
  let timeout: NodeJS.Timeout | undefined;

  try {
    const search = findProfiles({
      ...input.data,
      serperApiKey: process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
      tavilyApiKey: process.env.TAVILY_WEB_SEARCH_API_KEY,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      scrapeCreatorsApiKey: process.env.SCRAPECREATORS_API_KEY,
      socialCrawlApiKey: process.env.SOCIALCRAWL_API_KEY,
    });
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("PROFILE_SEARCH_TIMEOUT")),
        timeoutMs,
      );
    });
    const result = await Promise.race([search, deadline]);
    res.json(SearchProfilesResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Profile search failed");
    const timedOut =
      error instanceof Error && error.message === "PROFILE_SEARCH_TIMEOUT";
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "Profile search exceeded 60 seconds. Try fewer discovery methods or retry."
        : "Profile discovery is temporarily unavailable. Please try again.",
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

export default router;