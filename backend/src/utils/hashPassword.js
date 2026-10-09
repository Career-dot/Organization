const bcrypt = require("bcrypt");

const hashPassword = async (password) => {
  return bcrypt.hash(password, 12);
};

module.exports = hashPassword;