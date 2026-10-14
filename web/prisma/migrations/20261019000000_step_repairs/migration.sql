-- Phase 5 step 01: MAW repairs a step whose verify or deploy failed (REPAIRS
-- sessions at most) before blocking it.
ALTER TABLE "story_step" ADD COLUMN "repairs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "story_step" ADD COLUMN "repairReason" TEXT NOT NULL DEFAULT '';
