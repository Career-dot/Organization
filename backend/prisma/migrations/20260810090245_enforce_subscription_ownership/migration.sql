-- AddCheckConstraint
-- Ensures a Subscription belongs to exactly one owner: a user XOR an organization.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_ownership_check" CHECK (
    ("userId" IS NOT NULL AND "organizationId" IS NULL) OR
    ("userId" IS NULL AND "organizationId" IS NOT NULL)
);