const express = require("express");
const multer = require("multer");
const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const { MAX_FILE_SIZE } = require("./storage.service");
const {
  deleteFile,
  downloadFile,
  listFiles,
  uploadFile,
  viewFile,
} = require("./storage.controller");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const storageRoles = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN"];

const receiveUpload = (req, res, next) => {
  upload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ success: false, message: error.message });
    }
    return res.status(400).json({ success: false, message: error.message || "Invalid multipart upload" });
  });
};

router.use(authenticate, authorize(...storageRoles));
router.get("/", listFiles);
router.post("/", receiveUpload, uploadFile);
router.get("/:id/view", viewFile);
router.get("/:id/download", downloadFile);
router.delete("/:id", deleteFile);

module.exports = router;
