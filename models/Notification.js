const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema({
  user:      { type: String, required: true },
  type:      { type: String, default: "system" },
  title:     { type: String, required: true },
  message:   { type: String, required: true },
  amount:    { type: Number, default: 0 },
  txnId:     { type: String, default: "" },
  icon:      { type: String, default: "💬" },
  read:      { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("Notification", NotificationSchema);