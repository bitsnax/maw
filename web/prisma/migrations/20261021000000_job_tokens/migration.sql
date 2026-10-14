-- Phase 5 step 03: each session's token use (context at its end, tokens generated).
ALTER TABLE "story_job" ADD COLUMN "contextTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "story_job" ADD COLUMN "outputTokens" INTEGER NOT NULL DEFAULT 0;
