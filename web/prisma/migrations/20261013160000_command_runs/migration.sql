-- CreateTable
CREATE TABLE "command_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "lines" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "command_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "command_run_projectId_sessionId_startedAt_idx" ON "command_run"("projectId", "sessionId", "startedAt");

-- AddForeignKey
ALTER TABLE "command_run" ADD CONSTRAINT "command_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_run" ADD CONSTRAINT "command_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
