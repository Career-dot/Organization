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

// temporaryPassword is only ever interpolated into the email HTML below —
// never logged, never included in any thrown error, never returned to a
// caller beyond nodemailer's own send-result object.
const sendOrganizationCredentialsEmail = async ({
  email,
  fullName,
  organizationName,
  temporaryPassword,
}) => {
  console.log("📧 Preparing organization recruiter credentials email...");
  console.log("📧 To:", email);

  const loginUrl = `${process.env.FRONTEND_URL}/login`;

  try {
    const info = await transporter.sendMail({
      from: `"Verified Skills Passport" <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: `Your recruiter account for ${organizationName} on Verified Skills Passport`,

      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Hi ${fullName},</h2>

          <p>
            An account has been created for you as a recruiter for
            <strong>${organizationName}</strong> on Verified Skills Passport.
            You can log in immediately with the temporary credentials below.
          </p>

          <table style="margin: 16px 0; border-collapse: collapse;">
            <tr>
              <td style="padding: 4px 12px 4px 0; color:#475569;">Login email</td>
              <td style="padding: 4px 0; font-weight: bold;">${email}</td>
            </tr>
            <tr>
              <td style="padding: 4px 12px 4px 0; color:#475569;">Temporary password</td>
              <td style="padding: 4px 0;">
                <code style="background:#f1f5f9; padding:4px 8px; border-radius:4px; font-size:14px;">
                  ${temporaryPassword}
                </code>
              </td>
            </tr>
          </table>

          <p>
            <a
              href="${loginUrl}"
              style="
                display:inline-block;
                padding:12px 20px;
                background:#2563eb;
                color:white;
                text-decoration:none;
                border-radius:6px;
              "
            >
              Log in
            </a>
          </p>

          <p>
            For security, please change this password as soon as you log in.
          </p>

          <p>
            If you were not expecting this account, please contact your
            organization administrator.
          </p>
        </div>
      `,
    });

    console.log("✅ Credentials email accepted by SMTP server");
    console.log("Message ID:", info.messageId);
    console.log("Response:", info.response);

    return info;
  } catch (error) {
    console.error("❌ Organization credentials email sending failed:");
    console.error(error);

    throw error;
  }
};

module.exports = sendOrganizationCredentialsEmail;
