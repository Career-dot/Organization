
const bcrypt = require("bcrypt");

const comparePassword = async (password, passwordHash) => {
  return bcrypt.compare(password, passwordHash);
};

module.exports = comparePassword;

