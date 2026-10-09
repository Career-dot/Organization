const { getEmployeeProfileCompletionStatus } = require("../module/auth/auth.service");

const requireEmployeeProfileComplete = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  if (req.user.role !== "EMPLOYEE") {
    return next();
  }

  try {
    const completion = await getEmployeeProfileCompletionStatus(req.user.id);

    if (!completion.isComplete) {
      return res.status(403).json({
        success: false,
        code: "PROFILE_INCOMPLETE",
        message: "Complete your employee profile before accessing the dashboard.",
        data: {
          missingFields: completion.missingFields ?? [],
        },
      });
    }

    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to verify employee profile completion",
    });
  }
};

module.exports = requireEmployeeProfileComplete;
