import { Router, type IRouter } from "express";
import {
  SearchMusicianProfilesBody,
  SearchMusicianProfilesResponse,
} from "@workspace/api-zod";
import { findMusicianProfiles } from "../lib/musician-search";

const router: IRouter = Router();

router.post("/musicians/search", async (req, res): Promise<void> => {
  const input = SearchMusicianProfilesBody.safeParse(req.body);
  if (!input.success) {
    req.log.warn({ errors: input.error.message }, "Invalid musician search");
    res.status(400).json({ error: "Enter a musician name with at least 2 characters." });
    return;
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "Serper is not configured yet.",
      code: "SERPER_NOT_CONFIGURED",
    });
    return;
  }

  try {
    const result = await findMusicianProfiles({ ...input.data, apiKey });
    res.json(SearchMusicianProfilesResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Musician profile search failed");
    res.status(502).json({
      error: "Google search is temporarily unavailable. Please try again.",
    });
  }
});

export default router;