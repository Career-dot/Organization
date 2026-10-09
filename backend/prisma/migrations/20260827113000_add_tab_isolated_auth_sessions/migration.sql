-- Tab-isolated authentication sessions. Existing refresh tokens cannot be
-- safely associated with a newly introduced session selector, so invalidate
-- them. Users will authenticate once after this migration and receive a new
-- selector-bound refresh cookie.

ALTER TABLE "LoginSession"
  ADD COLUMN "sessionSelectorHash" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3);

ALTER TABLE "RefreshToken"
  ADD COLUMN "loginSessionId" TEXT,
  ADD COLUMN "usedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "replacedById" TEXT;

UPDATE "RefreshToken"
SET "revoked" = true,
    "revokedAt" = CURRENT_TIMESTAMP
WHERE "loginSessionId" IS NULL
  AND "revoked" = false;

CREATE UNIQUE INDEX "LoginSession_sessionSelectorHash_key"
  ON "LoginSession"("sessionSelectorHash");

CREATE INDEX "LoginSession_userId_revokedAt_idx"
  ON "LoginSession"("userId", "revokedAt");

CREATE INDEX "LoginSession_expiresAt_idx"
  ON "LoginSession"("expiresAt");

CREATE INDEX "RefreshToken_loginSessionId_revoked_expiresAt_idx"
  ON "RefreshToken"("loginSessionId", "revoked", "expiresAt");

CREATE INDEX "RefreshToken_userId_revoked_expiresAt_idx"
  ON "RefreshToken"("userId", "revoked", "expiresAt");

CREATE UNIQUE INDEX "RefreshToken_replacedById_key"
  ON "RefreshToken"("replacedById");

ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_loginSessionId_fkey"
  FOREIGN KEY ("loginSessionId") REFERENCES "LoginSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_replacedById_fkey"
  FOREIGN KEY ("replacedById") REFERENCES "RefreshToken"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
