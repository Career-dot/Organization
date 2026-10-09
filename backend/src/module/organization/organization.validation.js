const { z } = require("zod");

const isValidProfileImageValue = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "") {
    return true;
  }

  if (trimmed.startsWith("/api/files/")) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

// No password field: the temporary password is generated server-side (see
// provisionOrganizationRecruiter in organization.service.js), never
// supplied by the ORG_ADMIN.
//
// `.strict()` is deliberate and load-bearing: it REJECTS any request body
// carrying a `permissions` key with a 400 instead of silently ignoring it. A
// client still trying to post a permission matrix gets an explicit, immediate
// error rather than a quiet success that implies the values were applied.
//
// `email` is lowercased here so the value the service compares against the
// User.email @unique index is already normalized.
const createRecruiterSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, "Full name must be at least 3 characters")
      .max(100, "Full name cannot exceed 100 characters"),

    email: z.string().trim().email("Invalid email address").toLowerCase(),
  })
  .strict();

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "REMOVED"]),
});

const updateOrganizationProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Organization name must be at least 2 characters")
    .max(150, "Organization name cannot exceed 150 characters")
    .optional(),
  website: z
    .string()
    .trim()
    .url("Website must be a valid URL")
    .optional()
    .nullable(),
  businessEmail: z
    .string()
    .trim()
    .email("Business email must be a valid email address")
    .optional()
    .nullable(),
  // Shared User identity fields — accepted so the protected organization
  // profile endpoint can initialize missing shared fields (fill-only-if-empty
  // via getUserAccountFieldUpdate). fullName/email are intentionally NOT
  // accepted here: they are registration-owned and remain read-only in setup.
  phone: z.string().trim().max(50, "Phone number cannot exceed 50 characters").optional().nullable(),
  city: z.string().trim().max(120, "City cannot exceed 120 characters").optional().nullable(),
  country: z.string().trim().max(120, "Country cannot exceed 120 characters").optional().nullable(),
  profileImage: z
    .string()
    .trim()
    .max(5000, "Profile image URL is too long")
    .refine(isValidProfileImageValue, {
      message: "Profile image must be a valid absolute URL or a /api/files/ path",
    })
    .optional()
    .nullable(),
});

module.exports = {
  createRecruiterSchema,
  updateStatusSchema,
  updateOrganizationProfileSchema,
};
