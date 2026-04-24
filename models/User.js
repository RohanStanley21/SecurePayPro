const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role:     { type: String, enum: ["user", "admin"], default: "user" },

  // ── Wallet ──
  balance:      { type: Number, default: 124850 },
  trustScore:   { type: Number, default: 100 },
  rewardPoints: { type: Number, default: 450 },

  // ── Daily limit tracking ──
  dailySpent:      { type: Number, default: 0 },
  dailyLimitReset: { type: Date,   default: Date.now },

  // ── KYC ── (single definition, covers all needed statuses)
  kycStep:   { type: Number, default: 1 },
  kycStatus: {
    type: String,
    enum: ["unverified", "pending", "in_progress", "verified"],
    default: "unverified"
  },

  // ── Profile ──
  phone:       { type: String, default: "" },
  dateOfBirth: { type: String, default: "" },
  address:     { type: String, default: "" },

  // ── Security settings ──
  twoFactorEnabled:     { type: Boolean, default: true },
  notificationsEnabled: { type: Boolean, default: true },

}, { timestamps: true });

// Hash password before save
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.checkAndResetDaily = async function () {
  const now = new Date();
  const lastReset = new Date(this.dailyLimitReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    this.dailySpent = 0;
    this.dailyLimitReset = now;
    await this.save();
  }
};

userSchema.methods.comparePassword = async function (entered) {
  return await bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model("User", userSchema);