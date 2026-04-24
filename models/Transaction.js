const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  sender:   { type: String, required: true },
  receiver: { type: String, required: true },
  amount:   { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  location: { type: String, required: true },
  isFraud:   { type: Boolean, default: false },
  riskScore: { type: Number, default: 0 },
  riskLevel: { type: String, enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"], default: "LOW" },
  status:   { type: String, enum: ["pending", "completed", "blocked"], default: "completed" },
  note:     { type: String, default: "" },
  category: {
    type: String,
    enum: ["Food", "Travel", "Bills", "Shopping", "Transfer", "Others", "Rent", "Medicine"],
    default: "Transfer"
  },
  txnId: { type: String, unique: true, sparse: true },
}, { timestamps: true });

// NO next parameter — works on Mongoose 9
schema.pre("validate", function () {
  if (!this.txnId) {
    this.txnId = "SP" + Date.now().toString().slice(-8).toUpperCase() 
               + Math.random().toString(36).slice(2, 5).toUpperCase();
  }
});

module.exports = mongoose.model("Transaction", schema);