const fs = require("fs");
const {
  absolutePathFor,
  createStoredFile,
  deleteOwnedFile,
  findOwnedFile,
  listOwnedFiles,
  profileImageUrlFor,
} = require("./storage.service");

const sendError = (res, error) => res.status(error.status || 500).json({
  success: false,
  message: error.message || "File operation failed",
});

const uploadFile = async (req, res) => {
  try {
    const ownerType = req.user.role === "ORG_ADMIN" ? "ORGANIZATION" : req.user.role;
    const ownerId = ownerType === "ORGANIZATION" && req.body.category !== "PROFILE_IMAGE"
      ? req.user.organizationId
      : req.user.id;
    if (!ownerId) {
      return res.status(403).json({ success: false, message: "Organization membership is required" });
    }
    const file = await createStoredFile({
      userId: req.user.id,
      ownerId,
      role: req.user.role,
      ownerType,
      category: req.body.category,
      file: req.file,
      employeeProfileId: req.body.employeeProfileId,
      skillId: req.body.skillId,
      certificateId: req.body.certificateId,
      projectId: req.body.projectId,
    });
    return res.status(201).json({
      success: true,
      data: {
        ...file,
        ...(req.body.category === "PROFILE_IMAGE"
          ? { profileImage: profileImageUrlFor(file) }
          : {}),
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const listFiles = async (req, res) => {
  try {
    const files = await listOwnedFiles({
      userId: req.user.id,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });
    return res.status(200).json({ success: true, data: files });
  } catch (error) {
    return sendError(res, error);
  }
};

const sendFile = (disposition) => async (req, res) => {
  try {
    const file = await findOwnedFile({
      userId: req.user.id,
      role: req.user.role,
      id: req.params.id,
      organizationId: req.user.organizationId,
    });
    const filePath = absolutePathFor(file.storagePath);
    await fs.promises.access(filePath, fs.constants.R_OK);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", file.fileSize);
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.originalName)}"`);
    return res.sendFile(filePath);
  } catch (error) {
    return sendError(res, error.code === "ENOENT" ? Object.assign(new Error("File content is missing"), { status: 404 }) : error);
  }
};

const viewFile = sendFile("inline");
const downloadFile = sendFile("attachment");

const deleteFile = async (req, res) => {
  try {
    const userId = req.user.role === "ORG_ADMIN" ? req.user.organizationId : req.user.id;
    const file = await deleteOwnedFile({
      userId: req.user.id,
      role: req.user.role,
      id: req.params.id,
      organizationId: req.user.organizationId,
    });
    return res.status(200).json({ success: true, data: { id: file.id, deleted: true } });
  } catch (error) {
    return sendError(res, error);
  }
};

module.exports = { uploadFile, listFiles, viewFile, downloadFile, deleteFile };
