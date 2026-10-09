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

const registerSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, "Full name must be at least 3 characters")
      .max(100, "Full name cannot exceed 100 characters"),

    email: z
      .string()
      .trim()
      .email("Invalid email address")
      .toLowerCase(),

    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(100, "Password cannot exceed 100 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(
        /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/,
        "Password must contain at least one special character"
      ),

    role: z.enum(["EMPLOYEE", "RECRUITER", "ORG_ADMIN"]),

    organizationName: z
      .string()
      .trim()
      .min(2, "Organization name must be at least 2 characters")
      .max(150, "Organization name cannot exceed 150 characters")
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "ORG_ADMIN" && !data.organizationName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["organizationName"],
        message: "Organization name is required for organization registration",
      });
    }
  });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),

  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100, "Password cannot exceed 100 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(
      /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/,
      "Password must contain at least one special character"
    ),
});

const accountSettingsSchema = z.object({
  fullName: z.string().trim().min(3, "Full name must be at least 3 characters").max(100, "Full name cannot exceed 100 characters").optional(),
  profileImage: z
    .string()
    .trim()
    .max(5000, "Profile image URL is too long")
    .refine(isValidProfileImageValue, {
      message: "Profile image must be a valid absolute URL or a /api/files/ path",
    })
    .optional()
    .nullable(),
  phone: z.string().trim().max(50, "Phone number cannot exceed 50 characters").optional().nullable(),
  city: z.string().trim().max(120, "City cannot exceed 120 characters").optional().nullable(),
  country: z.string().trim().max(120, "Country cannot exceed 120 characters").optional().nullable(),
}).strict();

const switchRoleSchema = z.object({
  role: z.enum(["EMPLOYEE", "RECRUITER", "ORG_ADMIN", "SUPER_ADMIN"]),
});

const recruiterProfileSchema = z.object({
  companyName: z.string().trim().max(200, "Company name cannot exceed 200 characters").optional().nullable(),
  jobTitle: z.string().trim().max(200, "Job title cannot exceed 200 characters").optional().nullable(),
  businessEmail: z.union([
    z.string().trim().max(320, "Business email cannot exceed 320 characters").email("Business email must be valid"),
    z.literal(""),
  ]).optional().nullable(),
  businessPhone: z.string().trim().max(50, "Business phone cannot exceed 50 characters").optional().nullable(),
  linkedInUrl: z.union([
    z.string().trim().max(500, "LinkedIn URL cannot exceed 500 characters").url("LinkedIn URL must be valid"),
    z.literal(""),
  ]).optional().nullable(),
  companyWebsite: z.union([
    z.string().trim().max(500, "Company website cannot exceed 500 characters").url("Company website must be valid"),
    z.literal(""),
  ]).optional().nullable(),
  bio: z.string().trim().max(5000, "Bio cannot exceed 5000 characters").optional().nullable(),
  location: z.string().trim().max(200, "Location cannot exceed 200 characters").optional().nullable(),
  yearsExperience: z.number().int().min(0).max(100).optional().nullable(),
  specialties: z.string().trim().max(2000, "Specialties cannot exceed 2000 characters").optional().nullable(),
  // Shared User identity fields — accepted so the protected recruiter profile
  // endpoint can initialize missing shared fields (fill-only-if-empty via
  // getUserAccountFieldUpdate). fullName/email are intentionally NOT accepted
  // here: they are registration-owned and remain read-only in setup.
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
}).strict();

const employeeSkillProficiencySchema = z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]);

const candidateProfileSectionSchema = z.object({
  section: z.string().trim().min(1).optional(),
  data: z.record(z.any()).optional(),
}).passthrough();

const candidateEducationSchema = z.object({
  school: z.string().trim().min(1, "School is required"),
  degree: z.string().trim().optional().nullable(),
  fieldOfStudy: z.string().trim().optional().nullable(),
  startDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  endDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  isCurrent: z.boolean().optional(),
  grade: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
});

const candidateSkillSchema = z.object({
  name: z.string().trim().min(1, "Skill name is required"),
  category: z.string().trim().optional().nullable(),
  proficiency: employeeSkillProficiencySchema,
  yearsOfExperience: z.number().int().min(0).max(80).optional().nullable(),
});

const candidateProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required"),
  description: z.string().trim().min(1, "Project description is required"),
  role: z.string().trim().optional().nullable(),
  link: z.union([z.string().trim().url("Project link must be a valid URL"), z.literal("")]).optional().nullable(),
  startDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  endDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  isOngoing: z.boolean().optional(),
});

const candidateProjectSkillSchema = z.object({
  skillId: z.string().trim().optional().nullable(),
  customSkillName: z.string().trim().optional().nullable(),
  proficiency: employeeSkillProficiencySchema,
  yearsOfExperience: z.number().int().min(0).max(80).optional().nullable(),
}).refine((data) => Boolean(data.skillId || data.customSkillName?.trim()), {
  message: "Either a skill ID or a custom skill name is required",
  path: ["customSkillName"],
});

const candidateCertificateSchema = z.object({
  name: z.string().trim().min(1, "Certificate name is required"),
  skillId: z.string().trim().optional().nullable(),
  issuer: z.string().trim().optional().nullable(),
  issueDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  expiryDate: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional().nullable(),
  credentialId: z.string().trim().optional().nullable(),
  credentialUrl: z.union([z.string().trim().url("Credential URL must be valid"), z.literal("")]).optional().nullable(),
  description: z.string().trim().optional().nullable(),
});

const candidateExperienceLevelSchema = z.object({
  experienceLevel: z.enum(["ENTRY_LEVEL", "MID_LEVEL", "SENIOR_LEVEL", "LEAD", "EXECUTIVE"]),
});

const candidateProfileCompletionSchema = z.object({
  markComplete: z.boolean().optional(),
});

const candidateCareerLinksSchema = z.object({
  githubUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
  linkedInUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
}).strict();

module.exports = {
  registerSchema,
  changePasswordSchema,
  accountSettingsSchema,
  switchRoleSchema,
  recruiterProfileSchema,
  candidateProfileSectionSchema,
  candidateEducationSchema,
  candidateSkillSchema,
  candidateProjectSchema,
  candidateProjectSkillSchema,
  candidateCertificateSchema,
  candidateExperienceLevelSchema,
  candidateProfileCompletionSchema,
  candidateCareerLinksSchema,
};