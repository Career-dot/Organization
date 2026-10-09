import apiClient from "./apiClient";

export const getSubscriptionPlans = async () => {
  const { data } = await apiClient.get("/subscriptions/plans");
  return data;
};

export const initiateCheckout = async (planId, targetRole, organizationName) => {
  const { data } = await apiClient.post("/subscriptions/checkout", {
    planId,
    ...(targetRole ? { targetRole } : {}),
    ...(organizationName ? { organizationName } : {}),
  });
  return data;
};

export const confirmPayment = async (checkoutToken) => {
  const { data } = await apiClient.post("/subscriptions/payment", {
    checkoutToken,
  });
  return data;
};
