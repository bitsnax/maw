-- CreateTable
CREATE TABLE "pki" (
    "id" TEXT NOT NULL DEFAULT 'maw',
    "caCertPem" TEXT NOT NULL,
    "caKeyEnc" TEXT NOT NULL,
    "clientCertPem" TEXT NOT NULL,
    "clientKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pki_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 7017,
    "runAs" TEXT NOT NULL,
    "certFingerprint" TEXT NOT NULL,
    "certNotAfter" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "agentVersion" TEXT,
    "hostname" TEXT,

    CONSTRAINT "machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_action" (
    "id" TEXT NOT NULL,
    "machineId" TEXT,
    "machineName" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "ok" BOOLEAN NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machine_name_key" ON "machine"("name");

-- CreateIndex
CREATE INDEX "machine_action_machineId_createdAt_idx" ON "machine_action"("machineId", "createdAt");

-- CreateIndex
CREATE INDEX "machine_action_userId_idx" ON "machine_action"("userId");

-- AddForeignKey
ALTER TABLE "machine" ADD CONSTRAINT "machine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_action" ADD CONSTRAINT "machine_action_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_action" ADD CONSTRAINT "machine_action_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
