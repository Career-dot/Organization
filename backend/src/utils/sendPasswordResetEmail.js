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

const sendPasswordResetEmail = async ({
  email,
  fullName,
  token,
}) => {
  console.log("📧 Preparing password reset email...");
  console.log("📧 To:", email);

  const resetUrl =
    `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

  try {
    const info = await transporter.sendMail({
      from: `"Verified Skills Passport" <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: "Reset your password",

      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Hi, ${fullName}!</h2>

          <p>
            We received a request to reset your password.
            Click the button below to choose a new one.
          </p>

          <p>
            <a
              href="${resetUrl}"
              style="
                display:inline-block;
                padding:12px 20px;
                background:#2563eb;
                color:white;
                text-decoration:none;
                border-radius:6px;
              "
            >
              Reset Password
            </a>
          </p>

          <p>
            This link expires in 1 hour.
          </p>

          <p>
            If you did not request a password reset, you can safely ignore this email.
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

module.exports = sendPasswordResetEmail;
