// The shared provider boundary for the TWO logically distinct assessment
// emails. Both mailers in this folder (sendAssessmentInvitationEmail /
// sendAssessmentVerificationEmail) go through HERE, so there is exactly one
// place that talks to SMTP, exactly one delivery contract, and exactly one
// diagnostic shape — but still two separate lifecycle events with two separate
// purposes:
//
//   INVITATION_EMAIL  — recruiter pressed "Invite Selected". Carries the
//                       assessment link. NEVER a verification code.
//   VERIFICATION_EMAIL — candidate submitted their invited email on the
//                       assessment page AND the server confirmed a matching
//                       persisted invitation. Carries the code. Reached ONLY
//                       after that authorization check.
//
// Contract, deliberately mirroring the project's other per-purpose mailers:
//   * SMTP configured  → nodemailer, exactly like every other transactional
//                        email in the platform.
//   * SMTP NOT configured (local dev / verification harnesses) → the message
//                        body is written to the server log. That log line IS
//                        the deterministic test channel; harnesses parse it to
//                        drive the real public verification flow.
//   * Delivery is confirmed against the provider's own accepted/rejected
//     lists. A message the provider did not accept is a FAILURE — never a
//     reported success.
const nodemailer = require("nodemailer");

// The two email types, named so logs can distinguish them without guessing.
const ASSESSMENT_EMAIL_TYPES = Object.freeze({
  INVITATION: "INVITATION_EMAIL",
  VERIFICATION: "VERIFICATION_EMAIL",
});

const smtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.EMAIL_FROM);

const buildTransporter = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

// Safe, non-reversible recipient mask for diagnostics. The local part is
// reduced to its first character; the domain is kept because it is needed to
// tell a typo/bounce reason apart and is not itself a secret.
const maskEmail = (email) => {
  const value = String(email ?? "").trim();
  const at = value.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  return `${value[0]}***${value.slice(at)}`;
};
// Email diagnostics. Safe metadata ONLY — never the verification code, never a
// credential, never a token, never the full recipient.
//
// Note the wording: `providerAccepted` is what the SMTP server reported. It is
// deliberately NOT called "delivered" — a 250 means the provider took
// responsibility for the message, not that a human received it.
const logEmailAttempt = ({ type, email, channel, messageId, response, accepted, rejected, error }) => {
  const parts = [
    `[assessment-email] type=${type}`,
    `recipient=${maskEmail(email)}`,
    `channel=${channel ?? "none"}`,
  ];
  if (messageId) parts.push(`messageId=${messageId}`);
  if (response) parts.push(`smtpResponse=${response}`);
  if (accepted !== undefined) parts.push(`accepted=${accepted}`);
  if (rejected !== undefined) parts.push(`rejected=${rejected}`);
  parts.push(`outcome=${error ? "FAILED" : "PROVIDER_ACCEPTED"}`);
  if (error) parts.push(`error=${error}`);

  const line = parts.join(" ");
  if (error) {
    console.error(line);
  } else {
    console.log(line);
  }
};

// nodemailer resolves for a message it did NOT actually hand over: an
// unverified/misconfigured provider, or a recipient the server refused, still
// produces a resolved promise. Reporting success on that promise is exactly how
// a candidate silently never receives their mail while the UI claims success.
//
// No credential, token or recipient content is ever placed in the error.
const deliveryFailure = (type, reason) => {
  const error = new Error(
    "The email was not accepted by the mail provider. Check the SMTP configuration and retry — no duplicate invitation will be created."
  );
  error.status = 502;
  error.code = "ASSESSMENT_EMAIL_NOT_DELIVERED";
  error.emailType = type;
  error.reason = reason;
  return error;
};
// THE single delivery implementation. `devChannelLine` is the body written to
// the server log when SMTP is not configured (the deterministic test channel);
// it is never produced on the SMTP path.
const deliverAssessmentEmail = async ({ type, to, subject, text, html, devChannelLine }) => {
  if (!smtpConfigured()) {
    console.log(devChannelLine);
    logEmailAttempt({ type, email: to, channel: "console", accepted: 1, rejected: 0 });
    return { channel: "console", providerAccepted: true };
  }

  const transporter = buildTransporter();
  try {
    // Fail fast and loudly on an unusable provider (bad host/port/auth/TLS)
    // instead of discovering it per message.
    await transporter.verify();

    const info = await transporter.sendMail({
      from: `"Verified Skills Passport" <${process.env.EMAIL_FROM}>`,
      to,
      subject,
      text,
      html,
    });

    // The provider told us who it took. Anything short of "this exact
    // recipient was accepted" is a delivery failure, never a success.
    const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    const diagnostics = {
      type,
      email: to,
      channel: "smtp",
      messageId: info?.messageId ?? null,
      response: info?.response ?? null,
      accepted: accepted.length,
      rejected: rejected.length,
    };

    if (rejected.length > 0) {
      logEmailAttempt({ ...diagnostics, error: "RECIPIENT_REJECTED" });
      throw deliveryFailure(type, "RECIPIENT_REJECTED");
    }
    if (!accepted.includes(to)) {
      logEmailAttempt({ ...diagnostics, error: "RECIPIENT_NOT_ACCEPTED" });
      throw deliveryFailure(type, "RECIPIENT_NOT_ACCEPTED");
    }

    logEmailAttempt(diagnostics);
    return { channel: "smtp", providerAccepted: true, messageId: info?.messageId ?? null };
  } catch (error) {
    // A transport-level failure (DNS, TLS, auth, timeout) never reached the
    // accepted/rejected branch above, so it is reported here — still with safe
    // metadata only, never the recipient in full and never a credential.
    if (error?.code !== "ASSESSMENT_EMAIL_NOT_DELIVERED") {
      logEmailAttempt({
        type,
        email: to,
        channel: "smtp",
        error: error?.code ?? error?.message ?? "TRANSPORT_ERROR",
      });
    }
    throw error;
  } finally {
    transporter.close();
  }
};

// The candidate-facing assessment link. The opaque publicId segment is the
// capability that identifies the assessment; nothing else about the job,
// recruiter or candidate list is embedded in it.
const assessmentLink = (publicId) => `${process.env.FRONTEND_URL}/assessment/${publicId}`;

module.exports = {
  ASSESSMENT_EMAIL_TYPES,
  smtpConfigured,
  maskEmail,
  logEmailAttempt,
  deliverAssessmentEmail,
  assessmentLink,
};
