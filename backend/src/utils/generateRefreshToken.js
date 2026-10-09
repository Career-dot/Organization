const crypto = require("crypto");

const generateRefreshToken = () => {
  return crypto.randomBytes(64).toString("hex");
};

module.exports = generateRefreshToken;