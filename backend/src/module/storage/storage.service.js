const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../../config/prisma");

const STORAGE_ROOT = path.resolve(__dirname, "../../../storage");
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const OWNER_DIRECTORIES = {
  EMPLOYEE: "employees",
  RECRUITER: "recruiters",
  ORGANIZATION: "organizations",
};

const CATEGORY_DIRECTORIES = {
  PROFILE_IMAGE: "profile",
  SKILL_EVIDENCE: "skills",
  PROJECT_FILE: "projects",
  OTHER_CERTIFICATE: "certificates",
  RECRUITER_VERIFICATION: "verification",
  RECRUITER_DOCUMENT: "documents",
  ORGANIZATION_VERIFICATION: "verification",
  ORGANIZATION_DOCUMENT: "documents",
  JOB_CANDIDATE_LIST: "candidates",
  // Phase 7 — recruiter-uploaded candidate resumes (PDF/TXT). Stored under the
  // uploading recruiter's directory like the candidate list, so the existing
  // ownership/validation rules apply unchanged; the job association lives on
  // JobCandidateReference.resumeFileId, never on file ownership.
  JOB_CANDIDATE_RESUME: "candidate-resumes",
  OTHER: "other",
};

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

const PROJECT_FILE_MIME_EXTENSIONS = {
  "text/x-c": ".c",
  "text/x-c++": ".cpp",
  "text/x-c-header": ".h",
  "text/x-c++hdr": ".hpp",
  "text/x-java-source": ".java",
  "text/x-python": ".py",
  "application/javascript": ".js",
  "text/jsx": ".jsx",
  "application/typescript": ".ts",
  "text/tsx": ".tsx",
  "text/x-csharp": ".cs",
  "application/x-httpd-php": ".php",
  "text/x-go": ".go",
  "text/rust": ".rs",
  "application/sql": ".sql",
  "text/html": ".html",
  "text/css": ".css",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const PROJECT_FILE_EXTENSIONS = new Map(
  Object.entries(PROJECT_FILE_MIME_EXTENSIONS).map(([mimeType, extension]) => [extension, mimeType])
);
PROJECT_FILE_EXTENSIONS.set(".c++", "text/x-c++");
const STORAGE_MIME_EXTENSIONS = { ...MIME_EXTENSIONS, ...PROJECT_FILE_MIME_EXTENSIONS };
const STORAGE_EXTENSIONS = new Map(
  Object.entries(STORAGE_MIME_EXTENSIONS).map(([mimeType, extension]) => [extension, mimeType])
);
STORAGE_EXTENSIONS.set(".c++", "text/x-c++");

const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_EXTENSIONS));
const DANGEROUS_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-dosexec",
  "application/x-sh",
  "application/x-bat",
  "application/x-httpd-php",
  "application/javascript",
  "text/javascript",
  "text/html",
  "application/x-7z-compressed",
  "application/zip",
  "application/x-rar-compressed",
]);

const assertSafeId = (value, fieldName) => {
  if (value !== undefined && value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))) {
    const error = new Error(`${fieldName} is invalid`);
    error.status = 400;
    throw error;
  }
};

const assertOwnerType = (ownerType, role) => {
  const expected = role === "ORG_ADMIN" ? "ORGANIZATION" : role;
  if (!OWNER_DIRECTORIES[ownerType] || ownerType !== expected) {
    const error = new Error("The requested file owner is not valid for this account");
    error.status = 403;
    throw error;
  }
};

const validateUpload = (file, category, ownerType) => {
  if (!file) {
    const error = new Error("A file is required");
    error.status = 400;
    throw error;
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (category === "PROJECT_FILE" || category === "SKILL_EVIDENCE") {
    const normalizedMimeType = (category === "SKILL_EVIDENCE" ? STORAGE_EXTENSIONS : PROJECT_FILE_EXTENSIONS).get(extension);
    if (!normalizedMimeType) {
      const error = new Error(category === "SKILL_EVIDENCE" ? "This file type is not allowed" : "This project file extension is not allowed");
      error.status = 415;
      throw error;
    }
    file.mimetype = normalizedMimeType;
  } else if ((file.mimetype === "" || file.mimetype === "application/octet-stream") && extension === ".pdf") {
    file.mimetype = "application/pdf";
  }
  if (!CATEGORY_DIRECTORIES[category]) {
    const error = new Error("File category is invalid");
    error.status = 400;
    throw error;
  }
  if (!["PROJECT_FILE", "SKILL_EVIDENCE"].includes(category) && (DANGEROUS_MIME_TYPES.has(file.mimetype) || !ALLOWED_MIME_TYPES.has(file.mimetype))) {
    const error = new Error("This file type is not allowed");
    error.status = 415;
    throw error;
  }
  if (file.size > MAX_FILE_SIZE) {
    const error = new Error(`Files must be ${MAX_FILE_SIZE / 1024 / 1024} MB or smaller`);
    error.status = 413;
    throw error;
  }
  if (category === "PROFILE_IMAGE" && !file.mimetype.startsWith("image/")) {
    const error = new Error("Profile images must be JPG, PNG, WEBP, or GIF files");
    error.status = 415;
    throw error;
  }
  if (ownerType === "EMPLOYEE" && !["PROFILE_IMAGE", "SKILL_EVIDENCE", "OTHER_CERTIFICATE", "PROJECT_FILE", "OTHER"].includes(category)) {
    const error = new Error("File category is not supported for employee files");
    error.status = 400;
    throw error;
  }
};

const getEmployeeRelations = async ({ userId, employeeProfileId, skillId, certificateId, projectId }) => {
  const profile = await prisma.employeeProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) {
    const error = new Error("Employee profile not found");
    error.status = 404;
    throw error;
  }

  if (employeeProfileId && employeeProfileId !== profile.id) {
    const error = new Error("Employee profile does not belong to this account");
    error.status = 403;
    throw error;
  }

  const checks = [];
  if (skillId) checks.push(prisma.employeeProfileSkill.findFirst({ where: { id: skillId, employeeProfileId: profile.id }, select: { id: true } }));
  if (certificateId) checks.push(prisma.employeeProfileCertificate.findFirst({ where: { id: certificateId, employeeProfileId: profile.id }, select: { id: true } }));
  if (projectId) checks.push(prisma.employeeProfileProject.findFirst({ where: { id: projectId, employeeProfileId: profile.id }, select: { id: true } }));
  const results = await Promise.all(checks);
  if (results.some((result) => !result)) {
    const error = new Error("A related employee record does not belong to this account");
    error.status = 403;
    throw error;
  }

  return { employeeProfileId: profile.id, skillId: skillId || null, certificateId: certificateId || null, projectId: projectId || null };
};

const relativePathFor = ({ ownerType, ownerId, employeeProfileId, category, storedName, skillId, certificateId, projectId }) => {
  if (ownerType === "EMPLOYEE") {
    const profileId = employeeProfileId || ownerId;
    let relationFolder = CATEGORY_DIRECTORIES[category];
    if (category === "SKILL_EVIDENCE") relationFolder = path.posix.join(CATEGORY_DIRECTORIES[category], skillId || "unassigned");
    if (category === "OTHER_CERTIFICATE") relationFolder = path.posix.join(CATEGORY_DIRECTORIES[category], certificateId || "unassigned");
    if (category === "PROJECT_FILE") relationFolder = path.posix.join(CATEGORY_DIRECTORIES[category], projectId || "unassigned");
    return path.posix.join(OWNER_DIRECTORIES[ownerType], profileId, relationFolder, storedName);
  }
  return path.posix.join(OWNER_DIRECTORIES[ownerType], ownerId, CATEGORY_DIRECTORIES[category], storedName);
};

const absolutePathFor = (relativePath) => {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.includes("\\")) {
    const error = new Error("Stored file path is invalid");
    error.status = 500;
    throw error;
  }
  const absolutePath = path.resolve(STORAGE_ROOT, relativePath);
  if (absolutePath !== STORAGE_ROOT && !absolutePath.startsWith(`${STORAGE_ROOT}${path.sep}`)) {
    const error = new Error("Stored file path is outside the storage root");
    error.status = 500;
    throw error;
  }
  return absolutePath;
};

const removeStoredFileContent = async (storagePath) => {
  try {
    await fs.rm(absolutePathFor(storagePath), { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const removeEmptyStoredFileDirectory = async (storagePath) => {
  const filePath = absolutePathFor(storagePath);
  try {
    await fs.rmdir(path.dirname(filePath));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
  }
};

// PROFILE_IMAGE rows are replaced in place (one row per user), so the file id —
// and therefore the /view URL — never changes between uploads. Appending the
// row's updatedAt as a version query keeps the URL unique per replacement so
// clients re-fetch the new image instead of reusing a cached old one.
const profileImageUrlFor = (storedFile) =>
  `/api/files/${storedFile.id}/view?v=${new Date(storedFile.updatedAt).getTime()}`;

const createStoredFile = async ({ userId, ownerId = userId, role, ownerType, category, file, employeeProfileId, skillId, certificateId, projectId }) => {
  assertOwnerType(ownerType, role);
  const storageOwnerType = category === "PROFILE_IMAGE"
    ? "EMPLOYEE"
    : ownerType;
  assertSafeId(ownerId, "ownerId");
  assertSafeId(userId, "userId");
  assertSafeId(employeeProfileId, "employeeProfileId");
  assertSafeId(skillId, "skillId");
  assertSafeId(certificateId, "certificateId");
  assertSafeId(projectId, "projectId");
  validateUpload(file, category, ownerType);

  if (ownerType === "EMPLOYEE") {
    const relationChecks = {
      PROFILE_IMAGE: [],
      SKILL_EVIDENCE: ["skillId"],
      OTHER_CERTIFICATE: ["certificateId"],
      PROJECT_FILE: ["projectId"],
    };
    const requiredIds = relationChecks[category] ?? [];
    for (const requiredIdKey of requiredIds) {
      if (!{ skillId, certificateId, projectId }[requiredIdKey]) {
        const error = new Error(`${requiredIdKey} is required for this file category`);
        error.status = 400;
        throw error;
      }
    }
  }

  const relations = storageOwnerType === "EMPLOYEE" && category !== "PROFILE_IMAGE"
    ? await getEmployeeRelations({ userId, employeeProfileId, skillId, certificateId, projectId })
    : { employeeProfileId: null, skillId: null, certificateId: null, projectId: null };

  const previousProfileImages = category === "PROFILE_IMAGE"
    ? await prisma.storedFile.findMany({
        where: {
          ownerId: userId,
          category: "PROFILE_IMAGE",
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const previousOrganizationLogos = ownerType === "ORGANIZATION" && category === "ORGANIZATION_DOCUMENT"
    ? await prisma.storedFile.findMany({
        where: {
          ownerType: "ORGANIZATION",
          ownerId,
          category: "ORGANIZATION_DOCUMENT",
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const storedName = `${crypto.randomUUID()}${STORAGE_MIME_EXTENSIONS[file.mimetype]}`;
  const storagePath = relativePathFor({
    ownerType: storageOwnerType,
    ownerId,
    employeeProfileId: relations.employeeProfileId || employeeProfileId,
    category,
    storedName,
    skillId: relations.skillId || skillId,
    certificateId: relations.certificateId || certificateId,
    projectId: relations.projectId || projectId,
  });
  const absolutePath = absolutePathFor(storagePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  try {
    await fs.writeFile(absolutePath, file.buffer, { flag: "wx" });
  } catch (error) {
    try {
      await removeStoredFileContent(storagePath);
    } catch (cleanupError) {
      console.error("Failed to clean up profile upload after physical write failure:", cleanupError);
    }
    throw error;
  }

  try {
    const storedFile = await prisma.$transaction(async (tx) => {
      const fileData = {
        ownerType: storageOwnerType,
        ownerId,
        category,
        originalName: typeof file.originalname === "string" ? file.originalname.slice(0, 255) : "uploaded-file",
        storedName,
        mimeType: file.mimetype,
        fileSize: file.size,
        storagePath,
        ...relations,
      };
      const existingFile = category === "PROFILE_IMAGE"
        ? previousProfileImages[0]
        : previousOrganizationLogos[0];
      const createdFile = existingFile
        ? await tx.storedFile.update({
            where: { id: existingFile.id },
            data: fileData,
          })
        : await tx.storedFile.create({ data: fileData });

      if (category === "PROFILE_IMAGE") {
        await tx.user.update({
          where: { id: userId },
          data: {
            profileImage: profileImageUrlFor(createdFile),
          },
        });
      }

      return createdFile;
    });

    if (category === "PROFILE_IMAGE") {
      for (const previousProfileImage of previousProfileImages) {
        if (
          previousProfileImage.id === storedFile.id &&
          previousProfileImage.storagePath === storedFile.storagePath
        ) continue;
        try {
          await removeStoredFileContent(previousProfileImage.storagePath);
          await removeEmptyStoredFileDirectory(previousProfileImage.storagePath);
        } catch (cleanupError) {
          console.error("Failed to remove previous profile image after replacement:", cleanupError);
        }
      }
    }

    if (ownerType === "ORGANIZATION" && category === "ORGANIZATION_DOCUMENT") {
      for (const previousOrganizationLogo of previousOrganizationLogos) {
        if (previousOrganizationLogo.id === storedFile.id && previousOrganizationLogo.storagePath === storedFile.storagePath) continue;
        try {
          await removeStoredFileContent(previousOrganizationLogo.storagePath);
          await removeEmptyStoredFileDirectory(previousOrganizationLogo.storagePath);
        } catch (cleanupError) {
          console.error("Failed to remove previous organization logo after replacement:", cleanupError);
        }
      }
    }

    return storedFile;
  } catch (error) {
    try {
      await removeStoredFileContent(storagePath);
    } catch (cleanupError) {
      console.error("Failed to clean up profile upload after database failure:", cleanupError);
    }
    throw error;
  }
};

const findOwnedFile = async ({ userId, role, id, organizationId = null }) => {
  assertSafeId(id, "file id");
  const ownerType = role === "ORG_ADMIN" ? "ORGANIZATION" : role;
  assertOwnerType(ownerType, role);
  const file = await prisma.storedFile.findFirst({
    where: {
      id,
      OR: [
        { ownerType, ownerId: userId },
        { ownerType: "EMPLOYEE", ownerId: userId, category: "PROFILE_IMAGE" },
        ...(organizationId
          ? [{ ownerType: "ORGANIZATION", ownerId: organizationId, category: "ORGANIZATION_DOCUMENT" }]
          : []),
      ],
    },
  });
  if (!file) {
    const error = new Error("File not found");
    error.status = 404;
    throw error;
  }
  return file;
};

const listOwnedFiles = async ({ userId, role, organizationId = null }) => {
  const ownerType = role === "ORG_ADMIN" ? "ORGANIZATION" : role;
  assertOwnerType(ownerType, role);
  return prisma.storedFile.findMany({
    where: {
      OR: [
        { ownerType, ownerId: userId },
        { ownerType: "EMPLOYEE", ownerId: userId, category: "PROFILE_IMAGE" },
        ...(organizationId
          ? [{ ownerType: "ORGANIZATION", ownerId: organizationId, category: "ORGANIZATION_DOCUMENT" }]
          : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });
};

const deleteOwnedFile = async ({ userId, role, id, organizationId = null }) => {
  const file = await findOwnedFile({ userId, role, id, organizationId });
  if (file.category !== "PROFILE_IMAGE") {
    try {
      await prisma.storedFile.delete({ where: { id: file.id } });
    } catch (error) {
      if (error?.code !== "P2025") throw error;
    }

    await removeStoredFileContent(file.storagePath);
    await removeEmptyStoredFileDirectory(file.storagePath);
    return file;
  }

  const filesToDelete = await prisma.storedFile.findMany({
    where: {
      ownerType: "EMPLOYEE",
      ownerId: userId,
      category: "PROFILE_IMAGE",
    },
  });

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { profileImage: null },
    });

    await tx.storedFile.deleteMany({
      where: { id: { in: filesToDelete.map((storedFile) => storedFile.id) } },
    });
  });

  for (const storedFile of filesToDelete) {
    try {
      await removeStoredFileContent(storedFile.storagePath);
      await removeEmptyStoredFileDirectory(storedFile.storagePath);
    } catch (cleanupError) {
      console.error("Failed to remove profile image after metadata deletion:", cleanupError);
    }
  }
  return file;
};

module.exports = {
  STORAGE_ROOT,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  absolutePathFor,
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
  profileImageUrlFor,
  createStoredFile,
  findOwnedFile,
  listOwnedFiles,
  deleteOwnedFile,
};
