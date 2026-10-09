// ASSESSMENT INVITATION EMAIL — lifecycle event A.
//
// Triggered by exactly one thing: the recruiter's "Invite Selected" action,
// through the single existing row-scoped recruiter endpoint. It carries the
// assessment LINK and ordinary invitation information.
//
// It contains NO verification code, by construction: this function does not
// even accept a code/token parameter, so no caller can put one on this
// invitation email even by mistake. The code belongs to the later
// VERIFICATION email, which is only reachable after the candidate submits
// their email and the backend confirms a matching persisted invitation.
//
// The three TIMELINES are stated separately and are never conflated, because
// conflating them is how a candidate ends up surprised:
//   * assessment availability  - the recruiter's configured window, after which
//     the assessment is permanently unavailable;
//   * invitation link validity - stops ONE DAY EARLIER, so the link always dies
//     before the assessment does;
//   * assessment duration      - the timer that starts only once the candidate
//     presses Start, fixed by the recruiter for that assessment.
const {
  ASSESSMENT_EMAIL_TYPES,
  deliverAssessmentEmail,
  assessmentLink,
} = require("./assessmentMail");

// Titles and names are recruiter-authored free text, so they are HTML-escaped
// before they ever reach a rendered email body.
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDuration = (seconds) => {
  const total = Number(seconds);
  if (!Number.isInteger(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} minutes` : `${minutes} minutes ${rest} seconds`;
};

const formatDateTime = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
};

const sendAssessmentInvitationEmail = async ({
  email,
  candidateName,
  jobTitle,
  assessmentTitle,
  publicId,
  // Invitation link deadline (JobAssessmentInvitation.expiresAt).
  expiresAt,
  // The remaining timeline inputs. Each is rendered ONLY when the persisted value
  // exists, so the email never states a deadline the server does not hold.
  assessmentExpiresAt = null,
  durationSeconds = null,
  maxVisibilityHiddenEvents = null,
}) => {
  const link = assessmentLink(publicId);
  const greeting = candidateName ? `Hello ${candidateName},` : "Hello,";
  const linkExpiry = formatDateTime(expiresAt);
  const availability = formatDateTime(assessmentExpiresAt);
  const duration = formatDuration(durationSeconds);
  const hasTabLimit = Number.isInteger(maxVisibilityHiddenEvents) && maxVisibilityHiddenEvents > 0;

  const textLines = [
    greeting,
    "",
    jobTitle
      ? `You have been invited to take the assessment "${assessmentTitle}" for "${jobTitle}".`
      : `You have been invited to take the assessment "${assessmentTitle}".`,
    "",
    "HOW TO START",
    `1. Open the assessment link below: ${link}`,
    "2. Enter this email address on the page so we can confirm your invitation.",
    "3. We will email you a one-time verification code.",
    "4. Enter that code on the page. Once it is accepted you can start the assessment.",
    "",
    "Please keep the verification email private. The code is personal to you and",
    "expires shortly after it is issued. We will never ask you to forward it.",
  ];

  // --- Timeline: three separate facts, never merged into one number -----------
  const timeline = [];
  if (availability) {
    timeline.push(
      `* Assessment available until: ${availability}`,
      "  After this moment the assessment can no longer be started by anyone."
    );
  }
  if (linkExpiry) {
    timeline.push(
      `* Invitation link valid until: ${linkExpiry}`,
      "  The link stops working one day before the assessment does, so you always",
      "  have the final day to complete the assessment once you are inside it."
    );
  }
  if (duration) {
    timeline.push(
      `* Once you press Start you have: ${duration}`,
      "  The timer starts only when you begin, and it does not pause."
    );
  }
  if (timeline.length > 0) {
    textLines.push("", "TIMELINE", ...timeline);
  }

  // --- Rules: only what the backend actually enforces -------------------------
  // The tab-away limit is interpolated from the ONE exported service constant, so
  // this copy cannot drift away from the rule that is really enforced.
  const rules = [
    "RULES",
    "* Answer and submit using only the browser tab the assessment is running in.",
    "* Switching away from that tab is recorded by the server. Switching away",
    "  repeatedly is treated as an integrity violation and can end the attempt.",
  ];
  if (hasTabLimit) {
    rules.push(
      `* The current limit is ${maxVisibilityHiddenEvents} recorded tab-away events in one`,
      "  attempt. Reaching it closes the attempt immediately, and a closed attempt",
      "  cannot be reopened, retaken or corrected."
    );
  }
  rules.push(
    "* The timer is enforced by the server, not by your browser. Reloading the",
    "  page does not pause or reset it.",
    "* Once you submit, the attempt is final and cannot be taken again.",
    "* Give the assessment your full attention and follow the instructions above."
  );
  textLines.push("", ...rules, "",
    "If you were not expecting this invitation, you can safely ignore this email.");


  // --- HTML rendering of the exact same facts ---------------------------------
  const list = (items) =>
    `<ul style="font:14px Arial,sans-serif;color:#334155;line-height:1.6;padding-left:20px;margin:0">${items
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul>`;

  const htmlTimelineItems = [
    ...(availability
      ? [
          `Assessment available until: ${availability}. After this moment the assessment can no longer be started by anyone.`,
        ]
      : []),
    ...(linkExpiry
      ? [
          `Invitation link valid until: ${linkExpiry}. The link stops working one day before the assessment does, so you always have the final day to complete the assessment once you are inside it.`,
        ]
      : []),
    ...(duration
      ? [`Once you press Start you have: ${duration}. The timer starts only when you begin, and it does not pause.`]
      : []),
  ];

  const htmlRuleItems = [
    "Answer and submit using only the browser tab the assessment is running in.",
    "Switching away from that tab is recorded by the server. Switching away repeatedly is treated as an integrity violation and can end the attempt.",
    ...(hasTabLimit
      ? [
          `The current limit is ${maxVisibilityHiddenEvents} recorded tab-away events in one attempt. Reaching it closes the attempt immediately, and a closed attempt cannot be reopened, retaken or corrected.`,
        ]
      : []),
    "The timer is enforced by the server, not by your browser. Reloading the page does not pause or reset it.",
    "Once you submit, the attempt is final and cannot be taken again.",
    "Give the assessment your full attention and follow the instructions above.",
  ];

  const html = [
    `<p style="font:14px Arial,sans-serif">${escapeHtml(greeting)}</p>`,
    `<p style="font:14px Arial,sans-serif">${
      jobTitle
        ? `You have been invited to take the assessment <strong>${escapeHtml(assessmentTitle)}</strong> for <strong>${escapeHtml(jobTitle)}</strong>.`
        : `You have been invited to take the assessment <strong>${escapeHtml(assessmentTitle)}</strong>.`
    }</p>`,
    `<h2 style="font:600 15px Arial,sans-serif;margin:24px 0 8px">How to start</h2>`,
    `<ol style="font:14px Arial,sans-serif;color:#334155;line-height:1.6;padding-left:20px;margin:0">` +
      `<li>Open the assessment link below.</li>` +
      `<li>Enter this email address on the page so we can confirm your invitation.</li>` +
      `<li>We will email you a one-time verification code.</li>` +
      `<li>Enter that code on the page. Once it is accepted you can start the assessment.</li>` +
      `</ol>`,
    `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;font:600 14px Arial,sans-serif">Open the assessment</a></p>`,
    `<p style="font:12px Arial,sans-serif;color:#475569;word-break:break-all">${escapeHtml(link)}</p>`,
    `<p style="font:13px Arial,sans-serif;color:#475569">Please keep the verification email private. The code is personal to you and expires shortly after it is issued. We will never ask you to forward it.</p>`,
    ...(htmlTimelineItems.length > 0
      ? [`<h2 style="font:600 15px Arial,sans-serif;margin:24px 0 8px">Timeline</h2>${list(htmlTimelineItems)}`]
      : []),
    `<h2 style="font:600 15px Arial,sans-serif;margin:24px 0 8px">Rules</h2>${list(htmlRuleItems)}`,
    `<p style="font:12px Arial,sans-serif;color:#64748b;margin-top:24px">If you were not expecting this invitation, you can safely ignore this email.</p>`,
  ].join("");

  return deliverAssessmentEmail({
    type: ASSESSMENT_EMAIL_TYPES.INVITATION,
    to: email,
    subject: `You have been invited to the assessment "${assessmentTitle}"`,
    text: textLines.join("\n"),
    html,
    // Deterministic development/test channel. Deliberately contains NO code —
    // the harnesses assert that this line never carries one.
    devChannelLine:
      `[assessment-invitation] invitation email for ${email}: open ${link} ` +
      `(assessment "${assessmentTitle}"${jobTitle ? `, job "${jobTitle}"` : ""}, ` +
      `invitation window ends ${linkExpiry ?? "unset"}, ` +
      `assessment available until ${availability ?? "unset"}, ` +
      `duration ${duration ?? "unset"})`,
  });
};

module.exports = { sendAssessmentInvitationEmail };
