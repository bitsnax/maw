-- AlterTable
ALTER TABLE "project" ADD COLUMN     "deployCommand" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "story_step" ADD COLUMN     "deploy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deployOutput" TEXT NOT NULL DEFAULT '';
