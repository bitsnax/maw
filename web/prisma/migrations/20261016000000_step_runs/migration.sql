-- AlterTable
ALTER TABLE "story" ADD COLUMN     "runnerNote" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "story_step" ADD COLUMN     "diff" TEXT NOT NULL DEFAULT '';
