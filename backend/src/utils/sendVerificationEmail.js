const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
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
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP connection failed:", error);
  } else {
    console.log("✅ SMTP server is ready");
  }
});

// `subject`/`heading`/`introText`/`buttonLabel`/`expiryText`/`footnote` are
// optional overrides so the same mailer can also carry the Phase A
// "confirm adding an account" email for existing-email registrations. Every
// default preserves the historical verification-email copy verbatim.
// Only server-defined constants (never user input) are interpolated.
const sendVerificationEmail = async ({
  email,
  fullName,
  token,
  subject = "Verify your email address",
  heading = `Welcome, ${fullName}!`,
  introText = "Thank you for creating your account. Please verify your email address to activate your account.",
  buttonLabel = "Verify Email",
  expiryText = "This verification link expires in 24 hours.",
  footnote = "If you did not create this account, you can safely ignore this email.",
}) => {
  console.log("📧 Preparing verification email...");
  console.log("📧 To:", email);

  const verificationUrl =
    `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

  try {
    const info = await transporter.sendMail({
      from: `"Verified Skills Passport" <${process.env.EMAIL_FROM}>`,
      to: email,
      subject,

      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>${heading}</h2>

          <p>
            ${introText}
          </p>

          <p>
            <a
              href="${verificationUrl}"
              style="
                display:inline-block;
                padding:12px 20px;
                background:#2563eb;
                color:white;
                text-decoration:none;
                border-radius:6px;
              "
            >
              ${buttonLabel}
            </a>
          </p>

          <p>
            ${expiryText}
          </p>

          <p>
            ${footnote}
          </p>
        </div>
      `,
    });

    console.log("✅ Email accepted by SMTP server");
    console.log("Message ID:", info.messageId);
    console.log("Response:", info.response);

    return info;
  } catch (error) {
    console.error("❌ Email sending failed:");
    console.error(error);

    throw error;
  }
};

module.exports = sendVerificationEmail;