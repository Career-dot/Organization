const {
  getAvailablePlans,
  initiateCheckout,
  confirmPayment,
} = require("./subscription.service");

const listPlans = async (req, res) => {
  try {
    const plans = await getAvailablePlans();

    return res.status(200).json({
      success: true,
      data: plans,
    });
  } catch (error) {
    console.error("List plans error:", error.message);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

const checkout = async (req, res) => {
  try {
    const { planId, targetRole, organizationName } = req.body;

    const result = await initiateCheckout(
      req.user,
      planId,
      targetRole,
      organizationName
    );

    return res.status(200).json({
      success: true,
      message: "Checkout initiated",
      data: result,
    });
  } catch (error) {
    console.error("Checkout error:", error.message);

    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.subscription && { data: { subscription: error.subscription } }),
    });
  }
};

const pay = async (req, res) => {
  try {
    const { checkoutToken } = req.body;

    const result = await confirmPayment(req.user, checkoutToken);

    return res.status(200).json({
      success: true,
      message: "Payment successful. Subscription is now active.",
      data: result,
    });
  } catch (error) {
    console.error("Payment error:", error.message);

    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.subscription && { data: { subscription: error.subscription } }),
    });
  }
};

module.exports = {
  listPlans,
  checkout,
  pay,
};
