const mongoose = require("mongoose");

const loanSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  userEmail:    { type: String, required: true },
  loanType:     { type: String, required: true },
  principal:    { type: Number, required: true },
  interestRate: { type: Number, required: true },
  tenureMonths: { type: Number, required: true },
  emiAmount:    { type: Number, required: true },
  totalPayable: { type: Number, required: true },
  emisPaid:     { type: Number, default: 0 },
  status:       { type: String, enum: ["active", "completed"], default: "active" },
  nextDueDate:  { type: Date },
  startDate:    { type: Date, default: Date.now },
  completedAt:  { type: Date },
  loanId:       { type: String, unique: true },
}, { timestamps: true });

// Works on ALL Mongoose versions (5, 6, 7, 8)
// Uses async instead of next() callback — safer and universal
loanSchema.pre("save", async function () {
  if (!this.loanId) {
    this.loanId = "LN" + Date.now().toString().slice(-8).toUpperCase();
  }
});

module.exports = mongoose.model("Loan", loanSchema);