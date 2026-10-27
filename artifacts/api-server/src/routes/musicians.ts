import { Router, type IRouter } from "express";
import {
  ApproveProfileSuggestionsBody,
  ApproveProfileSuggestionsParams,
  ApproveProfileSuggestionsResponse,
  ListExistingProfilesQueryParams,
  ListExistingProfilesResponse,
  SearchProfilesBody,
  SearchProfilesResponse,
  ListProfileInvestigationsQueryParams,
  ListProfileInvestigationsResponse,
  GetMusicianCoverageResponse,
} from "@workspace/api-zod";
import { findProfiles, parseKnownProfileUrl, resolveKnownProfileIdentity } from "../lib/musician-search";
import { StartingProfileLookupError } from "../lib/starting-profile-lookup";
import {
  approveProfileSuggestions,
  listExistingProfiles,
} from "../lib/clickhouse-profiles";
import { listProfileInvestigations, saveProfileInvestigation } from "../lib/profile-investigations";
import { getMusicianCoverage, invalidateMusicianCoverage } from "../lib/musician-coverage";

const router: IRouter = Router();

router.get("/profiles/musician-coverage", async (req, res): Promise<void> => {
  try {
    res.json(GetMusicianCoverageResponse.parse(await getMusicianCoverage()));
  } catch (error) {
    req.log.error({ err: error }, "Musician coverage statistics failed");
    res.status(503).json({ error: "Musician coverage statistics are unavailable. Please retry." });
  }
});

router.get("/profiles/investigations", async (req, res): Promise<void> => {
  const input = ListProfileInvestigationsQueryParams.safeParse(req.query);
  if (!input.success || !Number.isSafeInteger(input.data.page ?? 1) || !Number.isSafeInteger(input.data.limit ?? 20)) {
    res.status(400).json({ error: "Invalid history pagination." });
    return;
  }
  try {
    const result = await listProfileInvestigations(input.data.page ?? 1, input.data.limit ?? 20);
    res.json(ListProfileInvestigationsResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Investigation history list failed");
    res.status(503).json({ error: "Investigation history is unavailable. Check ClickHouse table permissions or retry." });
  }
});

router.get("/profiles", async (req, res): Promise<void> => {
  const input = ListExistingProfilesQueryParams.safeParse(req.query);
  if (!input.success) {
    res.status(400).json({ error: "Invalid profile list parameters." });
    return;
  }

  const query = input.data.query ?? "";
  const profileType = input.data.profileType ?? "musician";
  const page = input.data.page ?? 1;
  const limit = input.data.limit ?? 25;
  const tier = input.data.tier;
  const sortBy = input.data.sortBy ?? "tier_rank";
  const sortDirection = input.data.sortDirection ?? "asc";

  try {
    const result = await listExistingProfiles({
      query,
      profileType,
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
  const requestStartedAt = performance.now();
  const input = SearchProfilesBody.safeParse(req.body);
  if (!input.success) {
    req.log.warn({ errors: input.error.message }, "Invalid profile search");
    res.status(400).json({ error: "Enter a name, a known social handle, or both." });
    return;
  }
  if (input.data.methods?.includes("tavily")) {
    res.status(400).json({ error: "Tavily is disabled for this project. Use Serper or Gemini instead." });
    return;
  }
  const urlOnly = !input.data.subject?.trim() && !input.data.handle?.trim();
  if (urlOnly && !input.data.knownProfileUrl) {
    res.status(400).json({ error: "Enter a name, a known social handle, or a profile URL." });
    return;
  }
  if (urlOnly && !parseKnownProfileUrl(input.data.knownProfileUrl!)) {
    res.status(400).json({ error: "Enter a public profile or reference-page URL, such as ESPN. For social platforms, use a profile rather than a post or video." });
    return;
  }

  let timeout: NodeJS.Timeout | undefined;

  try {
    const referencePlatform = urlOnly ? parseKnownProfileUrl(input.data.knownProfileUrl!)?.platform : undefined;
    if (referencePlatform === "web" && !process.env.SERPERDEV_API_KEY && !process.env.SERPER_API_KEY) {
      res.status(503).json({ error: "Public reference-page lookup is unavailable; Serper is not configured." });
      return;
    }
    if (urlOnly && referencePlatform !== "web" && referencePlatform !== "spotify" && !process.env.SCRAPECREATORS_API_KEY) {
      res.status(503).json({ error: "Profile URL lookup is unavailable; ScrapeCreators is not configured." });
      return;
    }
    const resolved = urlOnly
      ? await resolveKnownProfileIdentity(input.data.knownProfileUrl!, process.env.SCRAPECREATORS_API_KEY ?? "", process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY)
      : undefined;
    if (urlOnly && !resolved) {
      res.status(422).json({ error: referencePlatform === "web"
        ? "Could not identify this reference page from its indexed title and description. Try a specific public person or player profile URL."
        : "Could not read an account at that profile URL. Check the link and try again." });
      return;
    }
    const search = findProfiles({
      ...input.data,
      ...resolved,
      excludeReferencePlatform: urlOnly,
      serperApiKey: process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      scrapeCreatorsApiKey: process.env.SCRAPECREATORS_API_KEY,
      socialCrawlApiKey: process.env.SOCIALCRAWL_API_KEY,
    });
    const deadline = new Promise<never>((_, reject) => {
      // Reserve time for history persistence within the client's 65-second limit.
      const timeoutMs = urlOnly
        ? Math.max(1, Math.min(50_000, 55_000 - (performance.now() - requestStartedAt)))
        : 60_000;
      timeout = setTimeout(
        () => reject(new Error("PROFILE_SEARCH_TIMEOUT")),
        timeoutMs,
      );
    });
    const result = SearchProfilesResponse.parse(await Promise.race([search, deadline]));
    if (timeout) clearTimeout(timeout);
    if (urlOnly) {
      try {
        result.historyId = await saveProfileInvestigation(resolved!.knownProfileUrl, result);
        invalidateMusicianCoverage();
      } catch (error) {
        req.log.error({ err: error }, "Investigation history save failed");
        result.historySaveError = "Results were found, but this investigation could not be saved to shared history. Check storage permissions or retry the search.";
      }
    }
    res.json(SearchProfilesResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Profile search failed");
    if (error instanceof StartingProfileLookupError) {
      res.status(error.timedOut ? 504 : 502).json({ error: error.message });
      return;
    }
    const timedOut =
      error instanceof Error && error.message === "PROFILE_SEARCH_TIMEOUT";
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "Profile search timed out. Try fewer discovery methods or retry."
        : "Profile discovery is temporarily unavailable. Please try again.",
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

export default router;