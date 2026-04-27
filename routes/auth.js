const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const twilio     = require("twilio");
const User       = require("../models/User");
const auth       = require("../middleware/auth");

const SECRET = process.env.JWT_SECRET;

// ─────────────────────────────────────────────────────────
// 📧  EMAIL TRANSPORTER
// ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  tls:  { rejectUnauthorized: false }
});

async function sendEmail(to, subject, text, html) {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.log("⚠️  Email not configured — would have sent:", subject, "→", to);
      return;
    }
    await transporter.sendMail({
      from: `SecurePay Pro <${process.env.EMAIL_USER}>`,
      to, subject, text, html: html || undefined
    });
    console.log("✅ Email sent to:", to);
  } catch (err) {
    console.log("❌ EMAIL ERROR:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 📱  SMS via Twilio
// ─────────────────────────────────────────────────────────
async function sendSMS(phone, message) {
  try {
    if (!phone || !process.env.TWILIO_SID || !process.env.TWILIO_AUTH || !process.env.TWILIO_PHONE) {
      console.log("⚠️  SMS skipped — Twilio not configured or no phone");
      return;
    }
    const digits = phone.replace(/\D/g, "");
    const e164   = digits.length === 10 ? `+91${digits}` : `+${digits}`;
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
    const result = await client.messages.create({
      body: message, from: process.env.TWILIO_PHONE, to: e164,
    });
    console.log("✅ SMS sent to:", e164, "| SID:", result.sid);
  } catch (err) {
    console.log("❌ SMS ERROR:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 📝  REGISTER
// ─────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    let { name, email, password, phone } = req.body;

    if (!name || !email || !password || !phone)
      return res.status(400).json({ message: "All fields required ❌ (including phone)" });

    name  = name.trim();
    email = email.trim().toLowerCase();
    phone = phone.trim();

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: "User already exists ❌" });

    let role = "user";
    if (email === "rohanstanley@gmail.com") role = "admin";

    await User.create({ name, email, password, phone, role });

    const welcomeHtml = `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#f9fafb;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#4361ee,#7209b7);padding:36px;text-align:center">
    <div style="font-size:52px;margin-bottom:8px">🎉</div>
    <h1 style="color:#fff;margin:0;font-size:26px">Welcome to SecurePay Pro!</h1>
    <p style="color:#c4c9ff;margin:8px 0 0;font-size:15px">India's Smartest Payment Platform</p>
  </div>
  <div style="padding:32px">
    <p style="font-size:17px;color:#111">Hey <strong>${name}</strong>! 👋</p>
    <p style="color:#555;line-height:1.8">Your SecurePay Pro account is now <strong>live and ready</strong>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:20px 0">
      <tr style="background:#f1f5f9"><td style="padding:10px;color:#555">📧 Email</td><td style="padding:10px"><strong>${email}</strong></td></tr>
      <tr><td style="padding:10px;color:#555">📱 Phone</td><td style="padding:10px"><strong>${phone}</strong></td></tr>
      <tr style="background:#f1f5f9"><td style="padding:10px;color:#555">💰 Starting Balance</td><td style="padding:10px"><strong>Rs.1,24,850</strong></td></tr>
      <tr><td style="padding:10px;color:#555">⭐ Reward Points</td><td style="padding:10px"><strong>450 pts</strong></td></tr>
    </table>
    <div style="background:#eef1ff;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #4361ee">
      <strong style="color:#4361ee">🎁 Bonus Tip:</strong>
      <p style="color:#555;margin:6px 0 0;font-size:13px">Complete your KYC to unlock <strong>500 extra reward points</strong>!</p>
    </div>
    <p style="color:#4361ee;font-weight:bold">— SecurePay Pro Team</p>
  </div>
</div>`;

    const welcomeText = `Hi ${name}, Welcome to SecurePay Pro! Your account is live. Balance: Rs.1,24,850. Complete KYC to earn 500 bonus points! -SecurePay Pro`;

    sendEmail(email, "🎉 Welcome to SecurePay Pro — Your Account is Live!", welcomeText, welcomeHtml).catch(console.log);
    sendSMS(phone, `Hi ${name}! Welcome to SecurePay Pro. Your account is LIVE. Balance: Rs.1,24,850. Complete KYC for 500 bonus pts! -SecurePay Pro`).catch(console.log);

    res.json({ message: "Registered successfully ✅" });

  } catch (err) {
    console.log("REGISTER ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 🔑  LOGIN
// ─────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "All fields required ❌" });

    email = email.trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found ❌" });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ message: "Wrong password ❌" });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      role:         user.role,
      email:        user.email,
      name:         user.name,
      balance:      user.balance,
      rewardPoints: user.rewardPoints,
      trustScore:   user.trustScore,
      kycStep:      user.kycStep,
    });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 👤  GET PROFILE
// ─────────────────────────────────────────────────────────
router.get("/profile", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    res.json({
      name:         user.name,
      email:        user.email,
      phone:        user.phone        || "",
      dateOfBirth:  user.dateOfBirth  || "",
      address:      user.address      || "",
      balance:      user.balance      || 0,
      rewardPoints: user.rewardPoints || 0,
      trustScore:   user.trustScore   || 100,
      kycStep:      user.kycStep      || 1,
      kycStatus:    user.kycStatus    || "unverified",
      role:         user.role         || "user",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// ✏️  UPDATE PROFILE  (single definition — no duplicate)
// ─────────────────────────────────────────────────────────
router.put("/profile", auth, async (req, res) => {
  try {
    const { name, phone, dateOfBirth, address } = req.body;

    if (!name || name.trim().length < 2)
      return res.status(400).json({ message: "Full name must be at least 2 characters ❌" });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          name:        name.trim(),
          phone:       phone?.trim()   || "",
          dateOfBirth: dateOfBirth     || "",
          address:     address?.trim() || "",
        }
      },
      { new: true, runValidators: false }
    ).select("-password");

    if (!user) return res.status(404).json({ message: "User not found ❌" });

    console.log("✅ Profile updated for:", user.email, { phone: user.phone, dateOfBirth: user.dateOfBirth, address: user.address });

    res.json({
      message:     "Profile updated ✅",
      name:        user.name,
      email:       user.email,
      phone:       user.phone,
      dateOfBirth: user.dateOfBirth,
      address:     user.address,
    });
  } catch (err) {
    console.log("PROFILE UPDATE ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 🔐  KYC STEP
// ─────────────────────────────────────────────────────────
router.post("/kyc-step", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    if (user.kycStep >= 5) {
      return res.json({ message: "KYC already complete ✅", kycStep: user.kycStep });
    }

    user.kycStep  += 1;
    user.kycStatus = user.kycStep > 4 ? "verified" : "in_progress";

    if (user.kycStep > 4) {
      user.rewardPoints = (user.rewardPoints || 0) + 500;
    }

    await user.save();

    res.json({
      message:      `KYC Step ${user.kycStep - 1} verified ✅`,
      kycStep:      user.kycStep,
      kycStatus:    user.kycStatus,
      rewardPoints: user.rewardPoints,
    });
  } catch (err) {
    console.log("KYC STEP ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});
// ─────────────────────────────────────────────────────────
// 🔍  RESOLVE UPI HANDLE → EMAIL
// ─────────────────────────────────────────────────────────
router.get("/resolve-upi", auth, async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle) return res.status(400).json({ message: "Handle required" });

    // UPI handle is the part before @ in their email
    // e.g. handle = "john" → find user whose email starts with "john@"
    const users = await User.find({}).select("email name");
    const match = users.find(u =>
      u.email.split("@")[0].toLowerCase() === handle.toLowerCase().trim()
    );

    if (!match) return res.status(404).json({ message: "User not found" });

    res.json({ email: match.email, name: match.name });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
module.exports = router;