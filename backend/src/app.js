const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./module/auth/auth.routes");
const subscriptionRoutes = require("./module/subscription/subscription.routes");
const organizationRoutes = require("./module/organization/organization.routes");
const adminRoutes = require("./module/admin/admin.routes");
const jobRoutes = require("./module/job/job.routes");
const jobAssessmentPublicRoutes = require("./module/job/jobAssessmentPublic.routes");
const realtimeRoutes = require("./module/realtime/realtime.routes");
const storageRoutes = require("./module/storage/storage.routes");
const assessmentRoutes = require("./module/assessment/assessment.routes");
const notificationRoutes = require("./module/notification/notification.routes");
const app = express();

// ================================
// Middlewares
// ================================
if (!process.env.FRONTEND_URL) {
  throw new Error("FRONTEND_URL is not configured");
}

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Auth-Session",
      "X-Active-Role",
    ],
  })
);

// Employee profile images and certificate files use the existing JSON profile
// contract until a dedicated multipart storage endpoint is introduced.
app.use(express.json({ limit: "8mb" }));

app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/organization", organizationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/job", jobRoutes);
// Candidate-facing finalized-assessment read (opaque public link, no session).
// Mounted OUTSIDE /api/job on purpose: jobRoutes applies `authenticate` to
// every path it owns, and a candidate following the finalize-issued link has no
// account in this stage.
app.use("/api/assessment", jobAssessmentPublicRoutes);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/files", storageRoutes);
app.use("/api/auth/employee", assessmentRoutes);
app.use("/api/auth/employee", notificationRoutes);


// ================================
// Test Route
// ================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "AI Skill Verification Platform Backend is Running 🚀",
  });
});

// ================================
// Export App
// ================================

module.exports = app;
