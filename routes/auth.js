const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const twilio     = require("twilio");
const User       = require("../models/User");
const auth       = require("../middleware/auth");

const SECRET = process.env.JWT_SECRET;

// ─────────────────────────────────────────────────────────
// 🔢  IN-MEMORY OTP STORE  { email: { otp, expires } }
//     (use Redis in production for multi-instance deploys)
// ─────────────────────────────────────────────────────────
const resetOtpStore = {};

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
// 🔢  OTP GENERATOR
// ─────────────────────────────────────────────────────────
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

    const user = await User.create({ name, email, password, phone, role });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      SECRET,
      { expiresIn: "7d" }
    );

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

    res.json({
      token,
      message:      "Registered successfully ✅",
      role:         user.role,
      email:        user.email,
      name:         user.name,
      balance:      user.balance,
      rewardPoints: user.rewardPoints,
      trustScore:   user.trustScore,
      kycStep:      user.kycStep,
    });

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
// ✏️  UPDATE PROFILE
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

// ═════════════════════════════════════════════════════════
// 🔑  FORGOT PASSWORD — STEP 1: Send OTP to email
//     POST /api/auth/forgot-password
//     Body: { email }
// ═════════════════════════════════════════════════════════
router.post("/forgot-password", async (req, res) => {
  try {
    let { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required ❌" });
    email = email.trim().toLowerCase();

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      // Security: don't reveal whether email exists
      // But for UX we return a clear message since this is not a banking-grade production app
      return res.status(404).json({ message: "No account found with this email ❌" });
    }

    // Generate 6-digit OTP
    const otp = generateOTP();

    // Store with 10-minute expiry
    resetOtpStore[email] = {
      otp,
      expires:  Date.now() + 10 * 60 * 1000,  // 10 minutes
      name:     user.name,
      verified: false
    };

    console.log(`🔑 Password reset OTP for ${email}: ${otp}`);

    // ── Professional HTML email ─────────────────────────
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(67,97,238,0.12)">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4361ee,#7209b7);padding:36px;text-align:center">
            <div style="font-size:48px;margin-bottom:10px">🔐</div>
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px">
              Password Reset OTP
            </h1>
            <p style="color:rgba(255,255,255,0.7);margin:8px 0 0;font-size:14px">
              SecurePay Pro — Account Recovery
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px">
            <p style="font-size:16px;color:#0d1b2a;margin:0 0 8px">
              Hi <strong>${user.name}</strong> 👋
            </p>
            <p style="font-size:14px;color:#566573;line-height:1.7;margin:0 0 28px">
              We received a request to reset your SecurePay Pro password.
              Use the OTP below to verify your identity:
            </p>

            <!-- OTP Box -->
            <div style="background:linear-gradient(135deg,#eef1ff,#f3e8ff);border:2px solid #4361ee;border-radius:14px;padding:28px;text-align:center;margin:0 0 28px">
              <p style="font-size:12px;color:#566573;margin:0 0 10px;text-transform:uppercase;letter-spacing:2px;font-weight:700">
                Your One-Time Password
              </p>
              <div style="font-family:'Courier New',monospace;font-size:42px;font-weight:900;letter-spacing:12px;color:#4361ee;line-height:1">
                ${otp}
              </div>
              <p style="font-size:12px;color:#a0aab4;margin:12px 0 0;font-weight:600">
                ⏰ Valid for <strong style="color:#fb8500">10 minutes</strong> only
              </p>
            </div>

            <!-- Security Tips -->
            <div style="background:#fff4e6;border-radius:10px;padding:16px 20px;border-left:4px solid #fb8500;margin:0 0 24px">
              <p style="font-size:13px;color:#fb8500;font-weight:700;margin:0 0 6px">⚠️ Security Notice</p>
              <ul style="font-size:13px;color:#566573;margin:0;padding-left:18px;line-height:1.8">
                <li>Never share this OTP with anyone</li>
                <li>SecurePay staff will NEVER ask for your OTP</li>
                <li>If you didn't request this, ignore this email</li>
              </ul>
            </div>

            <p style="font-size:13px;color:#a0aab4;margin:0">
              This OTP will expire at
              <strong style="color:#566573">
                ${new Date(Date.now() + 10 * 60 * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST
              </strong>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f5f7ff;padding:20px 40px;border-top:1px solid #e2e8f7">
            <p style="font-size:12px;color:#a0aab4;margin:0;text-align:center;line-height:1.7">
              This is an automated message from <strong style="color:#4361ee">SecurePay Pro</strong>.
              Please do not reply to this email.<br>
              © 2025 SecurePay Pro · RBI Compliant · 256-bit AES Encryption
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = `SecurePay Pro — Password Reset OTP\n\nHi ${user.name},\n\nYour OTP to reset your password is: ${otp}\n\nThis OTP is valid for 10 minutes.\n\nDO NOT share this with anyone. SecurePay staff will never ask for your OTP.\n\nIf you didn't request this, please ignore this email.\n\n— SecurePay Pro Team`;

    await sendEmail(
      email,
      `SecurePay Pro — Your Password Reset OTP: ${otp}`,
      text,
      html
    );

    // Also send SMS if phone exists
    if (user.phone) {
      sendSMS(
        user.phone,
        `SecurePay OTP: ${otp} — use this to reset your password. Valid 10 min. DO NOT share. -SecurePay Pro`
      ).catch(() => {});
    }

    res.json({
      message: `OTP sent to ${email} ✅`,
      // Only expose OTP in development for testing
      ...(process.env.NODE_ENV !== "production" && { devOtp: otp })
    });

  } catch (err) {
    console.log("FORGOT-PASSWORD ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ═════════════════════════════════════════════════════════
// ✅  FORGOT PASSWORD — STEP 2: Verify OTP
//     POST /api/auth/verify-reset-otp
//     Body: { email, otp }
// ═════════════════════════════════════════════════════════
router.post("/verify-reset-otp", async (req, res) => {
  try {
    let { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ message: "Email and OTP are required ❌" });

    email = email.trim().toLowerCase();
    otp   = String(otp).trim();

    const stored = resetOtpStore[email];

    if (!stored)
      return res.status(400).json({ message: "OTP expired or not requested ❌" });

    if (Date.now() > stored.expires) {
      delete resetOtpStore[email];
      return res.status(400).json({ message: "OTP has expired. Please request a new one ❌" });
    }

    if (stored.otp !== otp)
      return res.status(400).json({ message: "Incorrect OTP ❌" });

    // Mark as verified — allows reset-password to proceed
    resetOtpStore[email].verified = true;

    res.json({ message: "OTP verified ✅" });

  } catch (err) {
    console.log("VERIFY-RESET-OTP ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ═════════════════════════════════════════════════════════
// 🔐  FORGOT PASSWORD — STEP 3: Set new password
//     POST /api/auth/reset-password
//     Body: { email, otp, newPassword }
// ═════════════════════════════════════════════════════════
router.post("/reset-password", async (req, res) => {
  try {
    let { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword)
      return res.status(400).json({ message: "All fields required ❌" });

    email = email.trim().toLowerCase();
    otp   = String(otp).trim();

    const stored = resetOtpStore[email];

    // Validate OTP one final time
    if (!stored)
      return res.status(400).json({ message: "OTP expired or not requested ❌" });
    if (!stored.verified)
      return res.status(400).json({ message: "OTP not verified yet ❌" });
    if (Date.now() > stored.expires) {
      delete resetOtpStore[email];
      return res.status(400).json({ message: "OTP session expired. Please start again ❌" });
    }
    if (stored.otp !== otp)
      return res.status(400).json({ message: "Invalid OTP ❌" });

    // Password strength check
    const pwRegex = /^(?=.*[a-zA-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9]).{8,}$/;
    if (!pwRegex.test(newPassword))
      return res.status(400).json({
        message: "Password must be 8+ chars with at least 1 letter, 1 number & 1 symbol ❌"
      });

    // Update password (pre-save hook in User model will hash it)
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    user.password = newPassword;
    await user.save();

    // Consume the OTP — one use only
    delete resetOtpStore[email];

    console.log(`✅ Password reset successful for: ${email}`);

    // Send confirmation email
    const confirmHtml = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(67,97,238,0.12)">
        <tr>
          <td style="background:linear-gradient(135deg,#06d6a0,#04a07a);padding:36px;text-align:center">
            <div style="font-size:52px;margin-bottom:10px">✅</div>
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800">Password Reset Successful!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px">
            <p style="font-size:16px;color:#0d1b2a">Hi <strong>${user.name}</strong>,</p>
            <p style="font-size:14px;color:#566573;line-height:1.7">
              Your SecurePay Pro password has been successfully reset on
              <strong>${new Date().toLocaleString("en-IN")}</strong>.
            </p>
            <div style="background:#e0faf4;border-radius:10px;padding:16px 20px;border-left:4px solid #06d6a0;margin:20px 0">
              <p style="font-size:13px;color:#06d6a0;font-weight:700;margin:0">🔒 Your account is secure</p>
              <p style="font-size:13px;color:#566573;margin:6px 0 0">If you did not make this change, contact us immediately.</p>
            </div>
            <p style="font-size:13px;color:#a0aab4">— SecurePay Pro Security Team</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    sendEmail(
      email,
      "SecurePay Pro — Password Reset Successful ✅",
      `Hi ${user.name}, your SecurePay Pro password was reset successfully on ${new Date().toLocaleString("en-IN")}. If you didn't do this, contact us immediately. -SecurePay Pro`,
      confirmHtml
    ).catch(() => {});

    if (user.phone) {
      sendSMS(
        user.phone,
        `SecurePay: Your password was reset successfully. If you didn't do this, contact support immediately. -SecurePay Pro`
      ).catch(() => {});
    }

    res.json({ message: "Password reset successful ✅. You can now sign in with your new password." });

  } catch (err) {
    console.log("RESET-PASSWORD ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

module.exports = router;