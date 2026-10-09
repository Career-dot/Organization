-- Duplicate-invitation delivery claim.
--
-- ONE job + assessment + normalized email = ONE invitation (already enforced by
-- the (assessmentId, email) unique index). That index stops a duplicate ROW, but
-- it does not stop a duplicate INVITATION EMAIL: two concurrent invites, a double
-- click or a network retry could each read the same persisted invitation and each
-- send the candidate a second email.
--
-- "invitationEmailSentAt" is the durable, race-safe claim that closes that gap.
-- NULL  = no invitation email has been claimed for this invitation yet.
-- SET   = the invitation email was claimed and the provider accepted it.
--
-- It is a CLAIM, not a delivery receipt: it never asserts a human received the
-- message (see the accepted/rejected provider contract in assessmentMail.js).
-- A failed send releases the claim, so a genuine retry can still reach a
-- candidate whose first attempt failed.
ALTER TABLE "JobAssessmentInvitation"
    ADD COLUMN "invitationEmailSentAt" TIMESTAMP(3);