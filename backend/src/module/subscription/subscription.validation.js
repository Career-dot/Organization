const { z } = require("zod");

const checkoutSchema = z.object({
  planId: z.string().trim().min(1, "planId is required"),
  targetRole: z.enum(["RECRUITER", "ORG_ADMIN"]).optional(),
  organizationName: z.string().trim().min(2).max(150).optional(),
});

const paymentSchema = z.object({
  checkoutToken: z.string().trim().min(1, "checkoutToken is required"),
});

module.exports = {
  checkoutSchema,
  paymentSchema,
};
