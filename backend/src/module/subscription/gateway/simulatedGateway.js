const crypto = require("crypto");

// Temporary stand-in for a real payment provider. Always succeeds; no network
// calls. Implements the same charge() signature a real gateway would, so it
// can be swapped out in paymentGateway.js without changing calling code.
const charge = async ({ amount, currency, metadata }) => {
  return {
    success: true,
    transactionId: `SIM-${crypto.randomBytes(12).toString("hex")}`,
    provider: "simulated",
  };
};

module.exports = {
  charge,
};
