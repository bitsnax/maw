-- CreateTable
CREATE TABLE "story_job" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "phaseId" TEXT,
    "stepId" TEXT,
    "itemId" TEXT,
    "kind" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "story_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_job_sessionId_key" ON "story_job"("sessionId");

-- CreateIndex
CREATE INDEX "story_job_storyId_createdAt_idx" ON "story_job"("storyId", "createdAt");

-- AddForeignKey
ALTER TABLE "story_job" ADD CONSTRAINT "story_job_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_job" ADD CONSTRAINT "story_job_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "story_phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_job" ADD CONSTRAINT "story_job_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "story_step"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_job" ADD CONSTRAINT "story_job_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "story_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
