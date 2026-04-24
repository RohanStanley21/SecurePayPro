const express      = require("express");
const router       = express.Router();
const auth         = require("../middleware/auth");
const Notification = require("../models/Notification");
const User         = require("../models/User");

// ─────────────────────────────────────────────
// GET /api/notifications  — fetch user's notifications
// ─────────────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const user  = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found" });

    const notifs = await Notification.find({ user: user.email })
      .sort({ createdAt: -1 })
      .limit(30);

    const unreadCount = notifs.filter(n => !n.read).length;

    res.json({ notifications: notifs, unreadCount });
  } catch (err) {
    console.log("GET NOTIFS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/notifications/mark-all-read
// ─────────────────────────────────────────────
router.post("/mark-all-read", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found" });

    await Notification.updateMany({ user: user.email, read: false }, { read: true });
    res.json({ message: "All marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/notifications/mark-read/:id
// ─────────────────────────────────────────────
router.post("/mark-read/:id", auth, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { read: true });
    res.json({ message: "Marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/notifications/clear — clear all
// ─────────────────────────────────────────────
router.delete("/clear", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found" });

    await Notification.deleteMany({ user: user.email });
    res.json({ message: "All notifications cleared" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;