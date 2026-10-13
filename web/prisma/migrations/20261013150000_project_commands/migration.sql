-- CreateTable
CREATE TABLE "project_command" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_command_projectId_position_idx" ON "project_command"("projectId", "position");

-- AddForeignKey
ALTER TABLE "project_command" ADD CONSTRAINT "project_command_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_command" ADD CONSTRAINT "project_command_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
