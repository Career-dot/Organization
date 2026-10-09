// ASSESSMENT EMAIL VERIFICATION EMAIL — lifecycle event B.
//
// Triggered by exactly one thing: the candidate submitted their email address
// on the candidate-facing assessment page AND the backend has already
// confirmed that this email matches a valid persisted invitation for THIS
// job + assessment (requireActiveInvitationContext). The authorization check
// therefore ALWAYS happens BEFORE this mailer is reached — the recruiter's
// invitation never reaches this function.
//
// This is the ONLY place in the candidate-assessment workflow that can put a
// verification code on the wire. The raw code exists only transiently, as the
// argument to `deliverAssessmentEmail`, and is never returned, never written
// by the diagnostics, and never persisted in plaintext (only its SHA-256 hash
// is stored).
const {
  ASSESSMENT_EMAIL_TYPES,
  smtpConfigured,
  deliverAssessmentEmail,
} = require("./assessmentMail");

const sendAssessmentVerificationEmail = async ({
  email,
  token,
  assessmentTitle,
  // The ASSESSMENT's availability deadline (Job.analysisEndsAt) - what the
  // candidate is really working towards. The invitation-link deadline is an
  // internal recruiter-side detail and is deliberately NOT shown here; the link
  // simply stops working when it is reached.
  expiresAt,
}) => {
  // Recruiter-authored text is HTML-escaped before it reaches a rendered body.
  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const safeTitle = escapeHtml(assessmentTitle);
  const availableUntil = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
    ? expiresAt.toUTCString()
    : null;

  const text =
    `You have been invited to the assessment "${assessmentTitle}".\n\n` +
    `Your verification code is:\n\n${token}\n\n` +
    `Enter this code on the assessment page to confirm your email and continue.\n` +
    (availableUntil
      ? `The assessment is available until ${availableUntil}.\n`
      : "") +
    `This code is personal to you, expires shortly after it is issued, and can be\n` +
    `used only once. We will never ask you to forward or share it.\n` +
    `If you were not expecting this invitation, you can safely ignore this email.`;

  const html =
    `<p>You have been invited to the assessment <strong>${safeTitle}</strong>.</p>` +
    `<p>Your verification code is:</p>` +
    `<p style="font-size:20px;letter-spacing:4px"><strong>${escapeHtml(token)}</strong></p>` +
    `<p>Enter this code on the assessment page to confirm your email and continue.</p>` +
    (availableUntil ? `<p>The assessment is available until ${escapeHtml(availableUntil)}.</p>` : "") +
    `<p style="color:#475569;font-size:13px">This code is personal to you, expires shortly ` +
    `after it is issued, and can be used only once. We will never ask you to forward ` +
    `or share it.</p>` +
    `<p style="color:#475569;font-size:13px">If you were not expecting this invitation, ` +
    `you can safely ignore this email.</p>`;

  return deliverAssessmentEmail({
    type: ASSESSMENT_EMAIL_TYPES.VERIFICATION,
    to: email,
    subject: "Verify your email to access your assessment",
    text,
    html,
    // Deterministic development/test channel. The token is the candidate's
    // verification code for THIS invitation; it lives only here (server logs)
    // and in the email that would be sent in production. The log-line format is
    // the documented contract the verification harnesses parse.
    devChannelLine:
      `[assessment-invitation] verification code for ${email}: ${token} ` +
      `(assessment "${assessmentTitle}", assessment available until ${availableUntil ?? "unset"})`,
  });
};

// smtpConfigured is re-exported from the shared boundary so every existing
// caller keeps ONE definition of "can this environment reach a real provider".
module.exports = { sendAssessmentVerificationEmail, smtpConfigured };
