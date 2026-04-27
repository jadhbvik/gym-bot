const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const cron = require("node-cron");
const twilio = require("twilio");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
require("dotenv").config();

// ================== CONFIG ==================
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET
});

const client = twilio(accountSid, authToken);

// ================== DB ==================
mongoose.connect(
  process.env.MONGO_URL,
  { family: 4 }
)
.then(() => console.log("MongoDB connected ✅"))
.catch(err => console.log(err));

// ================== SCHEMA ==================
const userSchema = new mongoose.Schema({
  name: String,
  phone: String,
  planDays: Number,
  startDate: Date,
  expiryDate: Date,
  lastNotified: Number
});

const User = mongoose.model("User", userSchema);

// ================== EXPRESS ==================
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const users = {};

// ================== BOT ==================
app.post("/webhook", async (req, res) => {
  const msg = req.body.Body.trim().toLowerCase();
  const from = req.body.From;

  if (!users[from]) users[from] = { step: "menu" };

  let reply = "";
  const state = users[from];

  // ================= MENU =================
  if (msg === "hi" || msg === "menu") {
    users[from] = { step: "menu" };
    reply = "Welcome 💪\n\n1. Join\n2. Renew\n3. Status";
  }

  // ================= HANDLE MENU OPTIONS ONLY IN MENU STATE =================
  else if (state.step === "menu" && msg === "1") {
  const user = await User.findOne({ phone: from });

  if (user && user.expiryDate > new Date()) {
    reply = `⚠️ You already have an active membership till ${user.expiryDate.toDateString()}.\n\nReply 2 to renew or extend.`;
    users[from] = { step: "menu" };
  } else {
    users[from] = { step: "name" };
    reply = "Enter your name:";
  }
  }

  else if (state.step === "menu" && msg === "2") {
    const user = await User.findOne({ phone: from });

    if (!user) {
      reply = "❌ You are not registered.";
      users[from] = { step: "menu" };
    } else {
      users[from] = {
        step: "renew_plan",
        name: user.name,
        isRenew: true
      };

      const isActive = user.expiryDate > new Date();

      reply = isActive
        ? `Active till ${user.expiryDate.toDateString()}\n\nChoose plan:\n1. 1 Month\n2. 3 Months`
        : "Plan expired\n\nChoose plan:\n1. 1 Month\n2. 3 Months";
    }
  }

  else if (state.step === "menu" && msg === "3") {
    const user = await User.findOne({ phone: from });

    reply = user
      ? `Expires on ${new Date(user.expiryDate).toDateString()}`
      : "❌ Not registered";

    users[from] = { step: "menu" };
  }

  // ================= STEP FLOW =================

  else if (state.step === "name") {
    state.name = msg;
    state.step = "plan";
    reply = "Select plan:\n1. 1 Month (₹1)\n2. 3 Months (₹2)";
  }

  else if (state.step === "plan") {
    let planDays = msg === "2" ? 90 : 30;
    let amount = msg === "2" ? 2 : 1;

    state.planDays = planDays;
    state.step = "payment_pending";

    const payment = await razorpay.paymentLink.create({
      amount: amount * 100,
      currency: "INR",
      description: "Gym Membership",
      customer: {
        name: state.name,
        contact: from.replace("whatsapp:+91", "")
      }
    });

    reply = `💳 Pay here:\n${payment.short_url}`;
  }

  else if (state.step === "renew_plan") {
    let planDays = msg === "2" ? 90 : 30;
    let amount = msg === "2" ? 2500 : 1000;

    state.planDays = planDays;
    state.step = "payment_pending";

    const payment = await razorpay.paymentLink.create({
      amount: amount * 100,
      currency: "INR",
      description: "Gym Renewal",
      customer: {
        name: state.name,
        contact: from.replace("whatsapp:+91", "")
      }
    });

    reply = `💳 Pay to renew:\n${payment.short_url}`;
  }

  else if (state.step === "payment_pending") {
    reply = "⏳ Waiting for payment...";
  }

  else {
    users[from] = { step: "menu" };
    reply = "Type HI to start";
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(`<Response><Message>${reply}</Message></Response>`);
});

// ================== RAZORPAY WEBHOOK ==================
app.post("/razorpay-webhook", async (req, res) => {
  const secret = "Viha@1703";

  const shasum = crypto.createHmac("sha256", secret);
  shasum.update(JSON.stringify(req.body));
  const digest = shasum.digest("hex");

  if (digest !== req.headers["x-razorpay-signature"]) {
    return res.status(400).send("Invalid signature");
  }

  const event = req.body;

  if (event.event === "payment_link.paid") {
  const data = event.payload.payment_link.entity;

  const phone = "whatsapp:+91" + data.customer.contact;
  const temp = users[phone];

  const user = await User.findOne({ phone });

  if (temp.isRenew && user) {
    // 🔥 RENEW LOGIC
    const baseDate = user.expiryDate < new Date() ? new Date() : user.expiryDate;

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + temp.planDays);

    user.expiryDate = newExpiry;
    user.lastNotified = null;
    await user.save();

    await sendMsg(phone, `✅ Renewed!\nNew expiry: ${newExpiry.toDateString()}`);
  } else {
    // 🔥 NEW USER
    const start = new Date();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + temp.planDays);

    await User.create({
      name: data.customer.name,
      phone,
      planDays: temp.planDays,
      startDate: start,
      expiryDate: expiry,
      lastNotified: null
    });

    await sendMsg(phone, `✅ Membership activated till ${expiry.toDateString()}`);
  }

  delete users[phone];
}

  res.json({ status: "ok" });
});

// ================== SEND MESSAGE ==================
async function sendMsg(to, text) {
  await client.messages.create({
    from: "whatsapp:+14155238886",
    to,
    body: text
  });
}

// ================== REMINDER ==================
function daysLeft(expiry) {
  return Math.ceil((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24));
}

async function checkExpiry() {
  const users = await User.find();

  for (let u of users) {
    const d = daysLeft(u.expiryDate);

    if (d === 1 && u.lastNotified !== 1) {
      await sendMsg(u.phone, "Expires tomorrow ⚠️");
      u.lastNotified = 1;
      await u.save();
    }
  }
}



app.get("/export", async (req, res) => {
  const users = await User.find();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Members");

  sheet.columns = [
    { header: "Name", key: "name" },
    { header: "Phone", key: "phone" },
    { header: "Plan Days", key: "planDays" },
    { header: "Expiry", key: "expiryDate" },
  ];

  users.forEach(u => sheet.addRow(u));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", "attachment; filename=members.xlsx");

  await workbook.xlsx.write(res);
  res.end();
});

cron.schedule("0 9 * * *", checkExpiry);

// ================== SERVER ==================
app.listen(3000, () => console.log("Server running"));