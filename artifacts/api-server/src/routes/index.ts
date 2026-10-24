import { Router, type IRouter } from "express";
import healthRouter from "./health";
import musiciansRouter from "./musicians";
import bulkBrandsRouter from "./bulk-brands";

const router: IRouter = Router();

router.use(healthRouter);
router.use(musiciansRouter);
router.use(bulkBrandsRouter);

export default router;
