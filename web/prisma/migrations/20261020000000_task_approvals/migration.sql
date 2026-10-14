-- Phase 5 step 02: hands-off approvals, a setting per task.
ALTER TABLE "story" ADD COLUMN "approve" TEXT NOT NULL DEFAULT 'you';
ALTER TABLE "story" ADD COLUMN "checksAtEnd" BOOLEAN NOT NULL DEFAULT false;
