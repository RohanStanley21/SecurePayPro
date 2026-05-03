const auth        = require("../middleware/auth");
const express     = require("express");
const router      = express.Router();
const Transaction = require("../models/Transaction");
const Notification = require("../models/Notification");
const User        = require("../models/User");
const Loan        = require("../models/Loan");
const nodemailer  = require("nodemailer");
const twilio      = require("twilio");
let PendingTxn;
try {
  PendingTxn = require("../models/PendingTransaction");
} catch(e) {
  console.log("⚠️ PendingTransaction model not found:", e.message);
}

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
      console.log("⚠️ Email not configured. Would have sent:", subject, "to:", to);
      return;
    }
    await transporter.sendMail({
      from: `SecurePay Pro <${process.env.EMAIL_USER}>`,
      to, subject, text, html: html || undefined
    });
    console.log("✅ Email sent to:", to, "| Subject:", subject);
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
      console.log("⚠️ SMS skipped — Twilio not configured or no phone");
      return;
    }
    const digits = phone.replace(/\D/g, "");
    const e164   = digits.length === 10 ? `+91${digits}` : `+${digits}`;
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE,
      to:   e164,
    });
    console.log("✅ SMS sent to:", e164, "| SID:", result.sid);
  } catch (err) {
    console.log("❌ SMS ERROR:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 🏷️  AUTO-CATEGORIZE FROM NOTE
// ─────────────────────────────────────────────────────────
function categorizeFromNote(note) {
  if (!note) return "Transfer";
  const n = note.toLowerCase();
  const rules = [
    { cat: "Rent",     words: ["rent","house rent","pg","hostel","flat rent","room rent","accommodation"] },
    { cat: "Food",     words: ["food","lunch","dinner","breakfast","zomato","swiggy","restaurant","cafe","biryani","pizza","burger","eat","snack","chai","coffee","hotel","meal","tiffin","dhaba","bakery","juice","drink","chicken","veg","thali"] },
    { cat: "Travel",   words: ["uber","ola","rapido","auto","cab","taxi","bus","train","flight","metro","travel","petrol","diesel","fuel","toll","irctc","redbus","makemytrip","yatra","trip","journey","ticket","booking","ride","bike","parking","highway"] },
    { cat: "Shopping", words: ["amazon","flipkart","myntra","meesho","ajio","nykaa","shopping","shop","clothes","shirt","dress","shoes","bag","watch","mobile","phone","laptop","electronics","online","order","purchase","buy","delivery","zepto","blinkit","swiggy instamart","groceries","grocery","market","supermarket","bigbasket","dmart","reliance"] },
    { cat: "Medicine", words: ["medicine","pharmacy","doctor","hospital","clinic","medical","health","pharma","tablet","syrup","injection","prescription","apollo","medplus","1mg","netmeds"] },
    { cat: "Bills",    words: ["electricity","electric","bill","water","gas","wifi","internet","broadband","recharge","maintenance","society","insurance","emi","loan","tax","jio","airtel","bsnl","vi","vodafone","idea","netflix","prime","hotstar","spotify","subscription","prepaid","postpaid","cylinder","lpg"] },
    { cat: "Others",   words: ["gift","birthday","salary","payment","fees","school","college","tuition","donation","charity","gym","sports","game","repair","service"] },
  ];
  for (const { cat, words } of rules) {
    if (words.some(w => n.includes(w))) return cat;
  }
  return "Transfer";
}

// ─────────────────────────────────────────────────────────
// 💰  PLATFORM FEE — single source of truth (server only)
//     NEVER trust the client-sent fee
// ─────────────────────────────────────────────────────────
function calcPlatformFee(amount) {
  if (amount > 10000) return 15;
  if (amount > 1000)  return 8;
  return 0;
}
async function createNotif(userEmail, type, title, message, amount = 0, txnId = "", icon = "💬") {
  try {
    await Notification.create({ user: userEmail, type, title, message, amount, txnId, icon });
  } catch (e) {
    console.log("NOTIF CREATE ERROR:", e.message);
  }
}

// ─────────────────────────────────────────────────────────
// 🔢  OTP STORES
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// 🔢  OTP STORES
// ─────────────────────────────────────────────────────────
const otpStore         = {};   // keyed by user email — payment OTPs
const loanOtpStore     = {};   // keyed by user email — loan OTPs
const verifiedOtpStore = {};   // keyed by user email — OTPs that passed verification
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ─────────────────────────────────────────────────────────
// 🔍  FRAUD DETECTION ENGINE
// ─────────────────────────────────────────────────────────
async function detectFraud(senderEmail, amount, location) {
  let riskScore = 0;
  const txns = await Transaction.find({ sender: senderEmail }).sort({ createdAt: -1 });
  const user  = await User.findOne({ email: senderEmail });

if      (amount < 1000)  riskScore += 5;
else if (amount < 5000)  riskScore += 10;
else if (amount < 20000) riskScore += 25;
else if (amount < 50000) riskScore += 40;
else                     riskScore += 80;

  if (!location || location.toLowerCase() === "unknown") riskScore += 20;

  const last1Min   = new Date(Date.now() - 60 * 1000);
  const recentTxns = txns.filter(t => new Date(t.createdAt) > last1Min);
  if (recentTxns.length > 3) riskScore += 30;

  if (txns.length > 0 && location !== "loan-verification") {
    const lastTxn = txns[0];
    if (lastTxn.location && lastTxn.location !== location &&
        lastTxn.location !== "unknown" && lastTxn.location !== "loan-verification") {
      riskScore += 15;
    }
  }

  if (user && user.trustScore < 40)      riskScore += 30;
  else if (user && user.trustScore < 70) riskScore += 15;

  const hour = new Date().getHours();
  if (hour < 5 || hour >= 23) riskScore += 10;

  let level   = "LOW";
  let isFraud = false;
if      (riskScore >= 70) { level = "HIGH"; }
else if (riskScore >= 30) { level = "MEDIUM"; }

  console.log(`Fraud | Sender:${senderEmail} Amount:${amount} Score:${riskScore} Level:${level}`);
  return { riskScore, level, isFraud };
}

// ─────────────────────────────────────────────────────────
// 💰  GET BALANCE
// ─────────────────────────────────────────────────────────
router.get("/balance", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("balance trustScore rewardPoints");
    res.json({ balance: user.balance, trustScore: user.trustScore, rewardPoints: user.rewardPoints });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// ➕  ADD MONEY
// ─────────────────────────────────────────────────────────
router.post("/add-money", auth, async (req, res) => {
  try {
    let { amount } = req.body;
    amount = Number(amount);
    if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount ❌" });
    if (amount > 100000)        return res.status(400).json({ message: "Max ₹1,00,000 per top-up ❌" });

    const user = await User.findById(req.user.id);
    user.balance      += amount;
    user.rewardPoints  = (user.rewardPoints || 0) + Math.floor(amount / 200);
    await user.save();
    await createNotif(
  user.email, "add_money", "Money Added ✅",
  `₹${amount.toLocaleString("en-IN")} added to your wallet. New balance: ₹${user.balance.toLocaleString("en-IN")}`,
  amount, "", "➕"
);

    const msg = `SecurePay: Rs.${amount.toLocaleString("en-IN")} added to your wallet. New balance: Rs.${user.balance.toLocaleString("en-IN")}. -SecurePay Pro`;
    await sendEmail(user.email, "SecurePay — Money Added to Wallet", msg);
    if (user.phone) sendSMS(user.phone, msg).catch(() => {});

    res.json({ message: `₹${amount.toLocaleString("en-IN")} added ✅`, balance: user.balance, rewardPoints: user.rewardPoints });
  } catch (err) {
    console.log("ADD-MONEY ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 📤  SEND OTP
// ─────────────────────────────────────────────────────────
router.post("/send-otp", auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(404).json({ message: "User not found ❌" });

    let { amount, location } = req.body;
    amount   = Number(amount);
    location = (location || "unknown").trim();

    if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount ❌" });

    // ── Loan OTP path ──────────────────────────────────────
    if (location === "loan-verification") {
      const otp = generateOTP();
      loanOtpStore[sender.email] = { otp, expires: Date.now() + 10 * 60 * 1000 };
      console.log(`Loan OTP for ${sender.email}: ${otp}`);

      const msg = `SecurePay Loan OTP: ${otp} - valid 10 minutes. Do NOT share. -SecurePay Pro`;
      await sendEmail(sender.email, "SecurePay Loan Verification OTP", msg);
      if (sender.phone) sendSMS(sender.phone, msg).catch(() => {});

      return res.json({
        message:   `Loan OTP sent to ${sender.email}`,
        skipOtp:   false,
        riskLevel: "LOW",
        devOtp:    process.env.NODE_ENV !== "production" ? otp : undefined
      });
    }

    // ── Payment OTP path ───────────────────────────────────
    const fraud = await detectFraud(sender.email, amount, location);

    // LOW risk → skip OTP, but still validate daily limit here
    if (fraud.level === "LOW") {
      // ✅ FIX: check daily limit even for low-risk (no OTP) payments
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTxns  = await Transaction.find({ sender: sender.email, createdAt: { $gte: todayStart } });
      const todayTotal = todayTxns.reduce((s, t) => s + t.amount, 0);

      if (todayTotal + amount > 100000) {
        return res.status(400).json({
          message: `Daily limit exceeded ❌ You've used ₹${todayTotal.toLocaleString("en-IN")} of ₹1,00,000 today. Remaining: ₹${(100000 - todayTotal).toLocaleString("en-IN")}`
        });
      }
      return res.json({ message: "Low risk — no OTP required", skipOtp: true, riskLevel: "LOW" });
    }

    const otp = generateOTP();
    otpStore[sender.email] = { otp, expires: Date.now() + 10 * 60 * 1000, location };
    console.log(`Payment OTP for ${sender.email}: ${otp} | Risk: ${fraud.level}`);

    const platformFee = calcPlatformFee(amount);
    const totalDeduct = amount + platformFee;
    const msg = `SecurePay OTP: ${otp} - valid 10 min. Amount: Rs.${amount.toLocaleString("en-IN")} + Fee: Rs.${platformFee} = Total: Rs.${totalDeduct.toLocaleString("en-IN")}. Risk: ${fraud.level}. Do NOT share. -SecurePay Pro`;
    await sendEmail(sender.email, "SecurePay OTP Verification", msg);
    if (sender.phone) sendSMS(sender.phone, msg).catch(() => {});

    res.json({
      message:     `OTP sent to ${sender.email}`,
      skipOtp:     false,
      riskLevel:   fraud.level,
      platformFee,
      devOtp:      process.env.NODE_ENV !== "production" ? otp : undefined
    });

  } catch (err) {
    console.log("SEND-OTP ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// ✅  VERIFY OTP + COMPLETE PAYMENT
// ─────────────────────────────────────────────────────────
router.post("/verify-otp", auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(404).json({ message: "User not found ❌" });

    // ✅ Destructure ALL fields including dryRun — must come first
    let { receiver, amount, otp, location, note, skipOtp, dryRun } = req.body;
    amount   = Number(amount);
    location = (location || "unknown").trim();

    // ── DRY RUN: validate OTP only, no money moves ──────────
    if (dryRun) {
      if (!skipOtp) {
        const stored = otpStore[sender.email];
        if (!stored)
          return res.status(400).json({ message: "OTP expired or not requested ❌" });
        if (stored.otp !== String(otp).trim())
          return res.status(400).json({ message: "Incorrect OTP ❌" });
        if (Date.now() > stored.expires) {
          delete otpStore[sender.email];
          return res.status(400).json({ message: "OTP expired ❌" });
        }
        verifiedOtpStore[sender.email] = { expires: Date.now() + 5 * 60 * 1000 };
        delete otpStore[sender.email];
      }
      return res.json({ message: "OTP verified ✅", otpValidated: true });
    }
    // ── END DRY RUN ──────────────────────────────────────────

    if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount ❌" });
    if (!receiver)              return res.status(400).json({ message: "Receiver email required ❌" });
    if (sender.email === receiver.trim().toLowerCase())
      return res.status(400).json({ message: "Cannot send money to yourself ❌" });

    const platformFee   = calcPlatformFee(amount);
    const totalDeducted = amount + platformFee;

    // ── OTP check ────────────────────────────────────────────
    if (!skipOtp) {
      const preVerified = verifiedOtpStore[sender.email];
      if (preVerified) {
        if (Date.now() > preVerified.expires) {
          delete verifiedOtpStore[sender.email];
          return res.status(400).json({ message: "OTP session expired. Please verify your OTP again ❌" });
        }
        delete verifiedOtpStore[sender.email]; // consume — one use only
      } else {
        const stored = otpStore[sender.email];
        if (!stored)
          return res.status(400).json({ message: "OTP expired or not requested ❌" });
        if (stored.otp !== String(otp).trim())
          return res.status(400).json({ message: "Incorrect OTP ❌" });
        if (Date.now() > stored.expires) {
          delete otpStore[sender.email];
          return res.status(400).json({ message: "OTP expired ❌" });
        }
        delete otpStore[sender.email];
      }
    }

    // ── Balance check ────────────────────────────────────────
    if (sender.balance < totalDeducted)
      return res.status(400).json({
        message: `Insufficient balance. Need ₹${totalDeducted.toLocaleString("en-IN")} (amount + ₹${platformFee} fee), you have ₹${sender.balance.toLocaleString("en-IN")} ❌`
      });

    // ── Daily limit check ────────────────────────────────────
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTxns = await Transaction.find({
  sender: sender.email,
  createdAt: { $gte: todayStart },
  status: "completed" // ✅ ONLY count completed — blocked/rejected never moved money
});
const todayTotal = todayTxns.reduce((s, t) => s + t.amount, 0);
    if (todayTotal + amount > 100000) {
      return res.status(400).json({
        message: `Daily limit exceeded ❌ Used: ₹${todayTotal.toLocaleString("en-IN")} / ₹1,00,000. Remaining today: ₹${Math.max(0, 100000 - todayTotal).toLocaleString("en-IN")}`
      });
    }

    // ── Fraud detection ──────────────────────────────────────
// ── Fraud detection ──────────────────────────────────────
const fraud = await detectFraud(sender.email, amount, location);

console.log("🔍 Fraud level:", fraud.level, "Score:", fraud.riskScore, "PendingTxn:", !!PendingTxn);

if (fraud.level === "HIGH") {
  if (!PendingTxn) {
    console.log("⚠️ PendingTxn model missing — loading now");
    PendingTxn = require("../models/PendingTransaction");
  }

  // 1️⃣ Create the pending approval record (admin review queue)
  const pending = await PendingTxn.create({
    sender:     sender.email,
    receiver:   receiver.trim().toLowerCase(),
    amount,
    platformFee,
    location,
    note,
    fraudScore: fraud.riskScore,
    riskLevel:  fraud.level,
    status:     "pending"
  });

  // 2️⃣ Also save a blocked-status Transaction so it appears in Blocked Transactions log
  await Transaction.create({
    sender:      sender.email.toLowerCase(),
    receiver:    receiver.trim().toLowerCase(),
    amount,
    platformFee,
    location,
    isFraud:     true,
    riskScore:   fraud.riskScore,
    riskLevel:   fraud.level,
    status:      "blocked",
    note,
    category:    "Transfer",
    fraudReason: `Sent for admin review — Fraud score: ${fraud.riskScore}`
  });

  // 3️⃣ Notify all admins
  const admins = await User.find({ role: "admin" });
  for (const admin of admins) {
    await createNotif(
      admin.email, "security",
      "⚠️ High Risk Transaction Pending",
      `₹${amount.toLocaleString("en-IN")} from ${sender.email} to ${receiver}. Score: ${fraud.riskScore}`,
      amount, pending._id.toString(), "⚠️"
    );
  }

  // 4️⃣ Notify the sender their transaction is under review
  await createNotif(
    sender.email, "security",
    "⏳ Transaction Under Review",
    `Your ₹${amount.toLocaleString("en-IN")} payment to ${receiver} is pending admin approval. Fraud score: ${fraud.riskScore}`,
    amount, pending._id.toString(), "⏳"
  );

  return res.json({
    requiresApproval: true,
    pendingId:        pending._id,
    riskLevel:        fraud.level,
    fraudScore:       fraud.riskScore,
    message:          "Transaction sent for admin review ⏳"
  });
}
    // ── Deduct from sender ───────────────────────────────────
    sender.balance     -= totalDeducted;
    sender.rewardPoints = (sender.rewardPoints || 0) + Math.floor(amount / 100);
    // ── Update trust score based on risk level ───────────────
sender.trustScore = Math.min(100, Math.max(0,
  fraud.level === "LOW"    ? Math.min(100, (sender.trustScore || 100) + 1)  :
  fraud.level === "MEDIUM" ? Math.max(0,   (sender.trustScore || 100) - 3)  :
                             Math.max(0,   (sender.trustScore || 100) - 10)
));

    await sender.save();

    // ── Credit receiver ──────────────────────────────────────
    const receiverUser = await User.findOne({ email: receiver.trim().toLowerCase() });
    if (receiverUser) {
      receiverUser.balance += amount;
      await receiverUser.save();
    }

    // ── Category resolution ──────────────────────────────────
    const resolvedCategory = (() => {
      if (!note) return "Transfer";
      const chipMap = {
        "rent":"Rent","food":"Food","medicine":"Medicine",
        "shopping":"Shopping","travel":"Travel","bills":"Bills","others":"Others"
      };
      const lower = note.toLowerCase();
      for (const [key, cat] of Object.entries(chipMap)) {
        if (lower.includes(key)) return cat;
      }
      return categorizeFromNote(note);
    })();

    // ── Save transaction ─────────────────────────────────────
    const txn = await Transaction.create({
      sender:    sender.email.toLowerCase(),
      receiver:  receiver.trim().toLowerCase(),
      amount, platformFee, location,
      isFraud:   fraud.isFraud,
      riskScore: fraud.riskScore,
      riskLevel: fraud.level,
      status:    "completed",
      note, category: resolvedCategory
    });
    console.log("✅ Transaction saved:", txn.txnId, txn.sender, "→", txn.receiver, txn.amount);

    await createNotif(sender.email, "sent", "Payment Sent 💸",
      `₹${amount.toLocaleString("en-IN")} sent to ${receiver}. Fee: ₹${platformFee}. Txn: ${txn.txnId}`,
      totalDeducted, txn.txnId, "💸");
    if (receiverUser) {
      await createNotif(receiver, "received", "Money Received 💰",
        `₹${amount.toLocaleString("en-IN")} received from ${sender.email}. Txn: ${txn.txnId}`,
        amount, txn.txnId, "💰");
    }

    // ── Send alerts ──────────────────────────────────────────
    const newDailyUsed = todayTotal + amount;
    const senderMsg = `SecurePay Alert: Rs.${amount.toLocaleString("en-IN")} sent to ${receiver}. Fee: Rs.${platformFee}. Total: Rs.${totalDeducted.toLocaleString("en-IN")}. Txn: ${txn.txnId}. Balance: Rs.${sender.balance.toLocaleString("en-IN")}. Risk: ${fraud.level}. -SecurePay Pro`;
    await sendEmail(sender.email, "SecurePay — Payment Debit Alert", senderMsg);
    if (sender.phone) sendSMS(sender.phone, senderMsg).catch(() => {});

    const receiverMsg = `SecurePay Alert: Rs.${amount.toLocaleString("en-IN")} received from ${sender.email}. Txn: ${txn.txnId}. -SecurePay Pro`;
    sendEmail(receiver, "SecurePay — Payment Credit Alert", receiverMsg).catch(() => {});
    if (receiverUser?.phone) sendSMS(receiverUser.phone, receiverMsg).catch(() => {});

    res.json({
      message:        "Payment successful ✅",
      txnId:          txn.txnId,
      riskLevel:      fraud.level,
      newBalance:     sender.balance,
      platformFee,
      totalDeducted,
      dailyUsed:      newDailyUsed,
      dailyRemaining: Math.max(0, 100000 - newDailyUsed)
    });

  } catch (err) {
    console.log("VERIFY-OTP ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});
// ─────────────────────────────────────────────────────────
// 📋  MY TRANSACTIONS
// ─────────────────────────────────────────────────────────
router.get("/my", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    const email = user.email.toLowerCase(); // normalize
    const txns = await Transaction.find({
      $or: [{ sender: email }, { receiver: email }]  // ← use normalized email
    }).sort({ createdAt: -1 }).limit(100);

    res.json({ transactions: txns });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 👑  ADMIN — ALL TRANSACTIONS
// ─────────────────────────────────────────────────────────
router.get("/all", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "Admins only ❌" });

    const txns        = await Transaction.find().sort({ createdAt: -1 }).limit(500);
    const userCount   = await User.countDocuments();                                    // ✅ ADD
    const totalAmount = txns.reduce((s, t) => s + t.amount, 0);
const fraudCount = txns.filter(t => t.isFraud || t.status === 'blocked').length;
const highRisk   = txns.filter(t => t.riskLevel === 'HIGH').length;

    res.json({
      transactions: txns,
      userCount,                                                                         // ✅ ADD
      summary: { totalAmount, totalTransactions: txns.length, fraudCount, highRisk }
    });
  } catch (err) {
    console.log("ADMIN ALL TXN ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 📊  ANALYTICS
// ─────────────────────────────────────────────────────────
router.get("/analytics", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    const txns       = await Transaction.find({ sender: user.email }).sort({ createdAt: -1 });
    const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
    const byCategory = {};
    txns.forEach(t => { byCategory[t.category || "Transfer"] = (byCategory[t.category || "Transfer"] || 0) + t.amount; });
    res.json({ totalSpent, byCategory, count: txns.length, transactions: txns });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 🏦  LOAN APPROVED — legacy notification endpoint
// ─────────────────────────────────────────────────────────
router.post("/loan-approved", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const { loanType, amount, emi, tenure, rate, startDate } = req.body;
    const amtFmt = Number(amount).toLocaleString("en-IN");
    const emiFmt = Number(emi).toLocaleString("en-IN");
    const total  = (emi * tenure).toLocaleString("en-IN");
    const text   =
      `SecurePay Pro — Loan Approved\n\nDear ${user.name},\n\n` +
      `Your ${loanType} has been approved!\n\n` +
      `Principal: Rs.${amtFmt}\nRate: ${rate}% p.a.\nTenure: ${tenure} months\n` +
      `Monthly EMI: Rs.${emiFmt}\nTotal Payable: Rs.${total}\nStart Date: ${startDate}\n\n— SecurePay Pro Team`;
    await sendEmail(user.email, `SecurePay — ${loanType} Approved | EMI Rs.${emiFmt}/month`, text);
    if (user.phone) sendSMS(user.phone, `SecurePay: ${loanType} of Rs.${amtFmt} APPROVED! EMI Rs.${emiFmt}/mo x ${tenure} months. -SecurePay Pro`).catch(() => {});
    res.json({ message: "Loan approval notification sent ✅" });
  } catch (err) {
    console.log("LOAN-APPROVED ERROR:", err);
    res.json({ message: "Notification attempted" });
  }
});

// ════════════════════════════════════════════════════════════
//  🏦  LOAN ROUTES
// ════════════════════════════════════════════════════════════
router.post("/loans/apply", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    let {
      loanType, principal,
      emiAmount, emi,
      tenureMonths, tenure,
      interestRate, rate,
      monthlyIncome, otp
    } = req.body;

    principal    = Number(principal);
    emiAmount    = Number(emiAmount    || emi);
    tenureMonths = Number(tenureMonths || tenure);
    interestRate = Number(interestRate || rate);

    if (!loanType)                          return res.status(400).json({ message: "Loan type is required ❌" });
    if (!principal    || principal    <= 0) return res.status(400).json({ message: "Valid principal amount is required ❌" });
    if (!emiAmount    || emiAmount    <= 0) return res.status(400).json({ message: "Valid EMI amount is required ❌" });
    if (!tenureMonths || tenureMonths <= 0) return res.status(400).json({ message: "Valid tenure is required ❌" });
    if (!interestRate || interestRate <  0) return res.status(400).json({ message: "Valid interest rate is required ❌" });

    if (!otp || String(otp).trim().length < 6)
      return res.status(400).json({ message: "Please enter the 6-digit OTP sent to your email ❌" });

    // ✅ FIX: use loanOtpStore (not otpStore) for loan OTPs
    const stored = loanOtpStore[user.email];
    if (!stored)
      return res.status(400).json({ message: "OTP expired or not requested. Please click Resend OTP ❌" });
    if (stored.otp !== String(otp).trim())
      return res.status(400).json({ message: "Incorrect OTP ❌" });
    if (Date.now() > stored.expires) {
      delete loanOtpStore[user.email];
      return res.status(400).json({ message: "OTP has expired. Please request a new one ❌" });
    }
    delete loanOtpStore[user.email];

    const totalPayable = parseFloat((emiAmount * tenureMonths).toFixed(2));
    const nextDue      = new Date();
    nextDue.setMonth(nextDue.getMonth() + 1);
    nextDue.setDate(5);

    const loan = await Loan.create({
      user: req.user.id, userEmail: user.email,
      loanType, principal, interestRate, tenureMonths,
      emiAmount, totalPayable, nextDueDate: nextDue,
    });
    // Credit loan principal to wallet
    user.balance += principal;
    await user.save();

    const amtFmt = principal.toLocaleString("en-IN");
    const emiFmt = emiAmount.toLocaleString("en-IN");

    const approvedText = `SecurePay: Your ${loanType} of Rs.${amtFmt} is APPROVED! ID: ${loan.loanId}. EMI: Rs.${emiFmt}/mo x ${tenureMonths} months. First EMI due: ${nextDue.toDateString()}. -SecurePay Pro`;
    sendEmail(user.email, `Loan Approved — Rs.${amtFmt} ${loanType} | ID: ${loan.loanId}`, approvedText).catch(console.log);
    if (user.phone) sendSMS(user.phone, approvedText).catch(() => {});

    res.json({ message: "Loan approved ✅", loan, newBalance: user.balance });

  } catch (err) {
    console.log("LOAN APPLY ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/payment/loans/my-loans
// ─────────────────────────────────────────────────────────
router.get("/loans/my-loans", auth, async (req, res) => {
  try {
    const raw = await Loan.find({ user: req.user.id }).sort({ createdAt: -1 });
    const loans = raw.map(l => ({
      _id: l._id, loanId: l.loanId, loanType: l.loanType, type: l.loanType,
      principal: l.principal, amount: l.principal,
      interestRate: l.interestRate, rate: l.interestRate,
      tenureMonths: l.tenureMonths, tenure: l.tenureMonths,
      emiAmount: l.emiAmount, emi: l.emiAmount,
      totalPayable: l.totalPayable, emisPaid: l.emisPaid, paid: l.emisPaid,
      status: l.status, completed: l.status === "completed",
      nextDueDate: l.nextDueDate, startDate: l.startDate || l.createdAt,
      completedAt: l.completedAt, createdAt: l.createdAt,
    }));
    res.json({ loans });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/payment/loans/my-loans/completed
// ─────────────────────────────────────────────────────────
router.get("/loans/my-loans/completed", auth, async (req, res) => {
  try {
    const loans = await Loan.find({ user: req.user.id, status: "completed" }).sort({ completedAt: -1 });
    res.json({ loans });
  } catch (err) {
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/payment/loans/:loanId/pay-emi
// ─────────────────────────────────────────────────────────
router.post("/loans/:loanId/pay-emi", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    const loan = await Loan.findOne({ _id: req.params.loanId, user: req.user.id });
    if (!loan)                         return res.status(404).json({ message: "Loan not found or not authorised ❌" });
    if (loan.status === "completed")   return res.status(400).json({ message: "This loan is already fully paid ✅" });
    if (user.balance < loan.emiAmount) return res.status(400).json({ message: `Insufficient balance. Need ₹${loan.emiAmount.toLocaleString("en-IN")}, you have ₹${user.balance.toLocaleString("en-IN")} ❌` });

    user.balance -= loan.emiAmount;
await user.save();

loan.emisPaid += 1;
const remaining = loan.tenureMonths - loan.emisPaid;  // ✅ defined first
const nextDue   = new Date(loan.nextDueDate || Date.now());
nextDue.setMonth(nextDue.getMonth() + 1);
loan.nextDueDate = nextDue;

await createNotif(           // ✅ now remaining is available
  user.email, "emi", "EMI Paid 📅",
  `₹${loan.emiAmount.toLocaleString("en-IN")} EMI paid for ${loan.loanType}. ${remaining} EMIs remaining.`,
  loan.emiAmount, loan.loanId, "📅"
);

    const isLastEmi = remaining === 0;
    if (isLastEmi) {
      loan.status      = "completed";
      loan.completedAt = new Date();
      user.rewardPoints = (user.rewardPoints || 0) + 200;
      await user.save();
    }
    await loan.save();

    const emiFmt = loan.emiAmount.toLocaleString("en-IN");
    const balFmt = user.balance.toLocaleString("en-IN");

    if (isLastEmi) {
      const celebText = `SecurePay: CONGRATS ${user.name}! Your ${loan.loanType} (ID:${loan.loanId}) is FULLY PAID! All ${loan.tenureMonths} EMIs done. 200 bonus pts added. Balance: Rs.${balFmt}. -SecurePay Pro`;
      sendEmail(user.email, `LOAN FULLY PAID! Your ${loan.loanType} is Cleared!`, celebText).catch(console.log);
      if (user.phone) sendSMS(user.phone, celebText).catch(() => {});
      return res.json({
        message: `🎉 FINAL EMI paid! Your ${loan.loanType} is FULLY REPAID! 200 bonus points added!`,
        newBalance: user.balance, rewardPoints: user.rewardPoints,
        emisPaid: loan.emisPaid, remaining: 0, loanCompleted: true,
        emiAmount: loan.emiAmount, loanType: loan.loanType
      });
    }

    const emiText = `SecurePay: EMI of Rs.${emiFmt} paid for ${loan.loanType} (ID:${loan.loanId}). ${loan.emisPaid}/${loan.tenureMonths} done. ${remaining} remaining. Next due: ${nextDue.toDateString()}. Balance: Rs.${balFmt}. -SecurePay Pro`;
    sendEmail(user.email, `EMI Paid — Rs.${emiFmt} | ${loan.loanType} | ${remaining} Remaining`, emiText).catch(console.log);
    if (user.phone) sendSMS(user.phone, emiText).catch(() => {});

    res.json({
      message: `✅ EMI of ₹${emiFmt} paid! ${remaining} EMI${remaining === 1 ? "" : "s"} remaining.`,
      newBalance: user.balance, rewardPoints: user.rewardPoints,
      emisPaid: loan.emisPaid, remaining, loanCompleted: false,
      emiAmount: loan.emiAmount, loanType: loan.loanType
    });

  } catch (err) {
    console.log("PAY-EMI ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// ─────────────────────────────────────────────────────────
// 🎁  REWARD REDEMPTION
// ─────────────────────────────────────────────────────────
router.post("/reward-redeem", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found ❌" });

    const { rewardType, amount, code } = req.body;
    let subject, emailText, smsText;

    if (rewardType === "cashback") {
      user.balance += 50;
      await user.save();
      subject   = "SecurePay Pro — ₹50 Cashback Credited! 🎉";
      emailText = `Hi ${user.name},\n\n₹50 cashback has been credited to your wallet.\n\nNew Balance: ₹${user.balance.toLocaleString("en-IN")}\n\n— SecurePay Pro Team`;
      smsText   = `SecurePay: Rs.50 cashback credited! New balance: Rs.${user.balance.toLocaleString("en-IN")}. -SecurePay Pro`;
    } else if (rewardType === "travel_voucher") {
      const voucherCode = code || ("SPTRAVEL" + Date.now().toString().slice(-6));
      subject   = `SecurePay Pro — Your ₹2,000 Travel Voucher! ✈️`;
      emailText = `Hi ${user.name},\n\nYour ₹2,000 Travel Voucher has been redeemed!\n\n🎟️ Voucher Code: ${voucherCode}\n\nClaim at:\n• MakeMyTrip\n• Yatra\n• IRCTC\n\nValid for 90 days.\n\n— SecurePay Pro Team`;
      smsText   = `SecurePay: Travel Voucher Rs.2000 redeemed! Code: ${voucherCode}. Use at MakeMyTrip/Yatra/IRCTC. Valid 90 days. -SecurePay Pro`;
    } else if (rewardType === "recharge") {
      const phone = user.phone || "your registered number";
      subject   = "SecurePay Pro — ₹100 Mobile Recharge Done! 📱";
      emailText = `Hi ${user.name},\n\n₹100 recharge has been added to ${phone}.\n\nProcessed: ${new Date().toLocaleString("en-IN")}\n\n— SecurePay Pro Team`;
      smsText   = `SecurePay: Rs.100 recharge added to ${phone}. Enjoy! -SecurePay Pro`;
    } else {
      return res.json({ message: "Reward noted ✅" });
    }

    await sendEmail(user.email, subject, emailText);
    if (user.phone) sendSMS(user.phone, smsText).catch(() => {});
    res.json({ message: "Reward redeemed and notified ✅" });

  } catch (err) {
    console.log("REWARD-REDEEM ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});
   // GET /api/payment/daily-usage
router.get("/daily-usage", auth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await Transaction.aggregate([
      {
        $match: {
          sender: req.user.email,
          status: "completed",
          createdAt: { $gte: today }
        }
      },
      {
        $group: {
          _id: null,
          totalUsed: { $sum: { $add: ["$amount", "$platformFee"] } }
        }
      }
    ]);

    const dailyUsed = result.length > 0 ? result[0].totalUsed : 0;
    res.json({ dailyUsed });

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
// GET /api/payment/pending-txns  (admin sees all pending)
router.get("/pending-txns", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "Admins only ❌" });
    if (!PendingTxn) return res.json({ pending: [] });
    const pending = await PendingTxn.find({ status: "pending" }).sort({ createdAt: -1 });
    res.json({ pending });
  } catch (err) {
    console.log("GET PENDING-TXNS ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// GET /api/payment/pending-txns-user  (sender checks their own)
router.get("/pending-txns-user", auth, async (req, res) => {
  try {
    if (!PendingTxn) return res.json([]);
    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(404).json({ message: "User not found" });
    const pending = await PendingTxn.find({ sender: sender.email, status: "pending" })
      .sort({ createdAt: -1 });
    res.json(pending); // ✅ plain array, not { pending: [...] }
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
// GET /api/payment/pending-txns-user-all  — sender sees ALL their records (any status)
router.get("/pending-txns-user-all", auth, async (req, res) => {
  try {
    if (!PendingTxn) return res.json([]);
    const sender = await User.findById(req.user.id);
    const all = await PendingTxn.find({ sender: sender.email })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(all);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
// POST /api/payment/pending-txns/:id/approve
router.post("/pending-txns/:id/approve", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "Admins only ❌" });
    if (!PendingTxn) return res.status(400).json({ message: "PendingTxn model not loaded ❌" });

    const pending = await PendingTxn.findById(req.params.id);
    if (!pending) return res.status(404).json({ message: "Pending txn not found ❌" });
    if (pending.status !== "pending") return res.status(400).json({ message: "Already processed ❌" });

    const sender = await User.findOne({ email: pending.sender });
    if (!sender) return res.status(404).json({ message: "Sender not found ❌" });

    const totalDeducted = pending.amount + pending.platformFee;
    if (sender.balance < totalDeducted)
      return res.status(400).json({ message: `Sender has insufficient balance ❌` });

    sender.balance -= totalDeducted;
    sender.rewardPoints = (sender.rewardPoints || 0) + Math.floor(pending.amount / 100);
    await sender.save();

    const receiverUser = await User.findOne({ email: pending.receiver });
    if (receiverUser) { receiverUser.balance += pending.amount; await receiverUser.save(); }

const txn = await Transaction.create({
  sender: pending.sender,
  receiver: pending.receiver,
  amount: pending.amount,
  platformFee: pending.platformFee,
  location: pending.location,
  note: pending.note,
  riskScore: pending.fraudScore,
  riskLevel: pending.riskLevel,
  isFraud: false,
  status: "completed",
  category: "Transfer"           // ← removed the comma and the bad line
});
pending.status = "approved";     // ← moved to HERE, outside the object
await pending.save();

    await createNotif(pending.sender, "sent", "✅ Transaction Approved",
      `Your ₹${pending.amount.toLocaleString("en-IN")} payment to ${pending.receiver} was approved. Txn: ${txn.txnId}`,
      pending.amount, txn.txnId, "✅");

    const msg = `SecurePay: Your payment of Rs.${pending.amount.toLocaleString("en-IN")} to ${pending.receiver} was APPROVED by admin. Txn: ${txn.txnId}. -SecurePay Pro`;
    sendEmail(pending.sender, "SecurePay — Payment Approved ✅", msg).catch(() => {});

    res.json({ message: "Approved ✅", txnId: txn.txnId, newBalance: sender.balance });
  } catch (err) {
    console.log("APPROVE ERROR:", err);
    res.status(500).json({ message: "Server error ❌" });
  }
});

// POST /api/payment/pending-txns/:id/reject
router.post("/pending-txns/:id/reject", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ message: "Admins only" });
    if (!PendingTxn)
      return res.status(400).json({ message: "PendingTxn model not loaded" });

    const pending = await PendingTxn.findById(req.params.id);
    if (!pending) return res.status(404).json({ message: "Not found" });

    if (pending.status !== "pending")
      return res.status(400).json({ message: `Already ${pending.status}` });

    const reason = req.body.reason || "Rejected by admin";
    pending.status  = "rejected";
    pending.reason  = reason;
    await pending.save();

    // ✅ Refund sender (HIGH-risk txns DO deduct on verify-otp — actually they DON'T)
    // HIGH-risk txns are blocked BEFORE deduction in verify-otp.
    // So NO refund needed. But mark the blocked Transaction as rejected.
    await Transaction.updateOne(
      { sender: pending.sender, amount: pending.amount, status: "blocked" },
      { $set: { status: "rejected", fraudReason: `Rejected by admin: ${reason}` } }
    );

    await createNotif(
      pending.sender, "security", "Transaction Rejected",
      `Your ₹${pending.amount.toLocaleString("en-IN")} payment to ${pending.receiver} was rejected. Reason: ${reason}`,
      pending.amount, pending.id.toString()
    );

    sendEmail(
      pending.sender,
      "SecurePay — Payment Rejected",
      `Your payment of Rs.${pending.amount.toLocaleString("en-IN")} to ${pending.receiver} was rejected. Reason: ${reason}. No money was deducted. -SecurePay Pro`
    ).catch(() => {});

    res.json({ message: "Rejected ✅" });
  } catch (err) {
    console.log("REJECT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});
// GET /api/payment/blocked-txns — admin sees all blocked/pending-review txns
router.get('/blocked-txns', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admins only' });
    
    const blocked = await Transaction.find({ status: 'blocked' })
      .sort({ createdAt: -1 }).limit(100);
    
    const pending = PendingTxn 
      ? await PendingTxn.find({ status: { $in: ['pending', 'approved', 'rejected'] } })
          .sort({ createdAt: -1 }).limit(100)
      : [];

    res.json({ blocked, pending });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;