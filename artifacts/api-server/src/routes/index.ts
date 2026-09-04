import { Router, type IRouter } from "express";
import healthRouter from "./health";
import musiciansRouter from "./musicians";

const router: IRouter = Router();

router.use(healthRouter);
router.use(musiciansRouter);

export default router;
