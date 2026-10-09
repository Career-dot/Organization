const { z } = require("zod");

// No password field: like organization-recruiter provisioning, the initial
// ORG_ADMIN's temporary password is generated server-side (see
// admin.service.js), never supplied by the SUPER_ADMIN.
const createOrganizationSchema = z.object({
  organizationName: z
    .string()
    .trim()
    .min(2, "Organization name must be at least 2 characters")
    .max(150, "Organization name cannot exceed 150 characters"),

  ownerFullName: z
    .string()
    .trim()
    .min(3, "Full name must be at least 3 characters")
    .max(100, "Full name cannot exceed 100 characters"),

  ownerEmail: z.string().trim().email("Invalid email address").toLowerCase(),
});

const updateOrganizationStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

const updateRecruiterStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

// billingCycle is pinned to the literal "MONTHLY" — the blueprint is
// explicit that all current plans are monthly-only and annual plans require
// an explicit future request, so this validation doesn't leave room to
// invent a second billing cycle through the API.
const createPlanSchema = z.object({
  name: z.string().trim().min(2, "Plan name must be at least 2 characters").max(100),
  type: z.enum(["RECRUITER", "ORGANIZATION"]),
  price: z.number().positive("Price must be greater than 0"),
  billingCycle: z.literal("MONTHLY"),
  maxUsers: z.number().int().positive("maxUsers must be a positive integer").nullable().optional(),
  jobPostingLimit: z.number().int().positive("jobPostingLimit must be a positive integer").nullable().optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional().default(true),
});

// `type` is deliberately NOT updatable — changing a plan's type after it
// may already have real subscriptions attached would retroactively change
// what those subscriptions economically mean, and would break
// loadPurchasablePlan's type-matching check for any future purchase. Create
// a new plan instead of repurposing an existing one's type.
const updatePlanSchema = z
  .object({
    name: z.string().trim().min(2, "Plan name must be at least 2 characters").max(100).optional(),
    price: z.number().positive("Price must be greater than 0").optional(),
    billingCycle: z.literal("MONTHLY").optional(),
    maxUsers: z.number().int().positive("maxUsers must be a positive integer").nullable().optional(),
    jobPostingLimit: z.number().int().positive("jobPostingLimit must be a positive integer").nullable().optional(),
    description: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

module.exports = {
  createOrganizationSchema,
  updateOrganizationStatusSchema,
  updateRecruiterStatusSchema,
  createPlanSchema,
  updatePlanSchema,
};
