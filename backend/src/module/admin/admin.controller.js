const {
  getDashboardStatistics,
  listOrganizations,
  getOrganizationDetail,
  getOrganizationSubscription,
  listRecruiters,
  getRecruiterDetail,
  listPlans,
  createPlan,
  updatePlan,
  listAuditLogsForAdmin,
} = require("./admin.service");

const respondError = (res, error, fallbackStatus = 400) => {
  console.error("Admin module error:", error.message);

  return res.status(error.status || fallbackStatus).json({
    success: false,
    message: error.message,
  });
};

const getDashboardHandler = async (req, res) => {
  try {
    const timeRange = req.query.timeRange || "all";
    const stats = await getDashboardStatistics(timeRange);

    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    return respondError(res, error, 500);
  }
};

const listOrganizationsHandler = async (req, res) => {
  try {
    const { search, status } = req.query;
    const organizations = await listOrganizations({ search, status });

    return res.status(200).json({ success: true, data: organizations });
  } catch (error) {
    return respondError(res, error, 500);
  }
};

const getOrganizationDetailHandler = async (req, res) => {
  try {
    const organization = await getOrganizationDetail(req.params.id);

    return res.status(200).json({ success: true, data: organization });
  } catch (error) {
    return respondError(res, error);
  }
};

const getOrganizationSubscriptionHandler = async (req, res) => {
  try {
    const result = await getOrganizationSubscription(req.params.id);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return respondError(res, error);
  }
};

const listRecruitersHandler = async (req, res) => {
  try {
    const { type, search } = req.query;
    const recruiters = await listRecruiters({ type, search });

    return res.status(200).json({ success: true, data: recruiters });
  } catch (error) {
    return respondError(res, error, 500);
  }
};

const getRecruiterDetailHandler = async (req, res) => {
  try {
    const recruiter = await getRecruiterDetail(req.params.id);

    return res.status(200).json({ success: true, data: recruiter });
  } catch (error) {
    return respondError(res, error);
  }
};

const listPlansHandler = async (req, res) => {
  try {
    const plans = await listPlans();

    return res.status(200).json({ success: true, data: plans });
  } catch (error) {
    return respondError(res, error, 500);
  }
};

const createPlanHandler = async (req, res) => {
  try {
    const plan = await createPlan(req.user, req.body, req.ip);

    return res.status(201).json({
      success: true,
      message: "Subscription plan created successfully",
      data: plan,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

const updatePlanHandler = async (req, res) => {
  try {
    const updated = await updatePlan(req.user, req.params.id, req.body, req.ip);

    return res.status(200).json({
      success: true,
      message: "Subscription plan updated successfully",
      data: updated,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

const listAuditLogsHandler = async (req, res) => {
  try {
    const result = await listAuditLogsForAdmin(req.query);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return respondError(res, error, 500);
  }
};

module.exports = {
  getDashboardHandler,
  listOrganizationsHandler,
  getOrganizationDetailHandler,
  getOrganizationSubscriptionHandler,
  listRecruitersHandler,
  getRecruiterDetailHandler,
  listPlansHandler,
  createPlanHandler,
  updatePlanHandler,
  listAuditLogsHandler,
};
