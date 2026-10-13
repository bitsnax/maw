-- AlterTable
ALTER TABLE "command_run" ADD COLUMN     "storyId" TEXT;

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "profile" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "protectedBranches" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verifyCommands" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "story" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "branch" TEXT,
    "overview" TEXT NOT NULL DEFAULT '',
    "outOfScope" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_phase" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "approach" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_phase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_step" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "files" TEXT NOT NULL DEFAULT '',
    "check" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "goal" TEXT NOT NULL DEFAULT '',
    "readBudget" TEXT NOT NULL DEFAULT '',
    "context" TEXT NOT NULL DEFAULT '',
    "changes" TEXT NOT NULL DEFAULT '',
    "verification" TEXT NOT NULL DEFAULT '',
    "manualCheck" TEXT NOT NULL DEFAULT '',
    "result" TEXT NOT NULL DEFAULT '',
    "verifyOutput" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_item" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "phaseId" TEXT,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "developer" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_finding" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "phaseId" TEXT,
    "itemId" TEXT,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_projectId_number_key" ON "story"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "story_phase_storyId_number_key" ON "story_phase"("storyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "story_step_phaseId_number_key" ON "story_step"("phaseId", "number");

-- CreateIndex
CREATE INDEX "story_item_storyId_phaseId_position_idx" ON "story_item"("storyId", "phaseId", "position");

-- CreateIndex
CREATE INDEX "story_finding_storyId_phaseId_position_idx" ON "story_finding"("storyId", "phaseId", "position");

-- AddForeignKey
ALTER TABLE "story" ADD CONSTRAINT "story_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story" ADD CONSTRAINT "story_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_phase" ADD CONSTRAINT "story_phase_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_step" ADD CONSTRAINT "story_step_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "story_phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_item" ADD CONSTRAINT "story_item_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_item" ADD CONSTRAINT "story_item_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "story_phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_finding" ADD CONSTRAINT "story_finding_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_finding" ADD CONSTRAINT "story_finding_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "story_phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_finding" ADD CONSTRAINT "story_finding_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "story_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
