import { Router, type IRouter } from "express";
import healthRouter from "./health";
import musiciansRouter from "./musicians";
import bulkBrandsRouter from "./bulk-brands";
import artistResultsRouter from "./artist-results";

const router: IRouter = Router();

router.use(healthRouter);
router.use(musiciansRouter);
router.use(bulkBrandsRouter);
router.use(artistResultsRouter);

export default router;
