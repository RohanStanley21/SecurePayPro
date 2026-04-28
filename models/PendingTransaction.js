const mongoose = require("mongoose");

const pendingTxnSchema = new mongoose.Schema({
  sender:      { type: String, required: true },
  receiver:    { type: String, required: true },
  amount:      { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  location:    { type: String, default: "unknown" },
  note:        { type: String, default: "" },
  fraudScore:  { type: Number, default: 0 },
  riskLevel:   { type: String, default: "HIGH" },
  status:      { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  reason:      { type: String, default: "" },
}, { timestamps: true });

module.exports = mongoose.model("PendingTransaction", pendingTxnSchema);