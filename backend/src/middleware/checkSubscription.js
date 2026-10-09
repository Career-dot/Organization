const { resolveSubscriptionAccess } = require("../module/subscription/subscription.service");

// Must run after authenticate (and authorize, per the request pipeline).
// 401 if somehow reached without req.user, 402 if the required subscription
// (personal or organization's, per resolveSubscriptionAccess) is missing,
// expired, cancelled, or suspended.
const checkSubscription = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const access = await resolveSubscriptionAccess(req.user);

  if (!access.allowed) {
    return res.status(402).json({
      success: false,
      message: "An active subscription is required to access this resource",
    });
  }

  req.subscription = access;

  next();
};

module.exports = checkSubscription;
