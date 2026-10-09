const simulatedGateway = require("./simulatedGateway");

// Interface: charge({ amount, currency, metadata }) => { success, transactionId, provider }
// Selected via PAYMENT_GATEWAY_PROVIDER env (defaults to "simulated"). A future
// StripeGateway module would implement the same charge() signature and be
// added to this map without touching the service/controller/routes layer.
const gateways = {
  simulated: simulatedGateway,
};

const provider = process.env.PAYMENT_GATEWAY_PROVIDER || "simulated";

const paymentGateway = gateways[provider];

if (!paymentGateway) {
  throw new Error(`Unknown payment gateway provider: ${provider}`);
}

module.exports = paymentGateway;
