import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════
//  إعدادات التليجرام المدمجة
// ═══════════════════════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = "YUOR_TOKEN_HERE";
const TELEGRAM_CHAT_ID = "YOUR_ID";

// ═══════════════════════════════════════════════════════════
//  مسارات الملفات
// ═══════════════════════════════════════════════════════════
const TOKENS_FILE = path.join(__dirname, "tokens.txt");
const AVAILABLE_FILE = path.join(__dirname, "available_usernames.txt");
const UNAVAILABLE_FILE = path.join(__dirname, "unavailable_users.txt");

// ═══════════════════════════════════════════════════════════
//  ألوان الطرفية
// ═══════════════════════════════════════════════════════════
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

// ═══════════════════════════════════════════════════════════
//  Discord API — فحص اسم المستخدم
// ═══════════════════════════════════════════════════════════
// الـ device profiles بتحاكي Discord Android بشكل واقعي
const DEVICE_PROFILES = [
  { build: 308011, device: "lake", locale: "ar-EG", tz: "Asia/Baghdad" },
  { build: 305009, device: "a54x", locale: "en-US", tz: "America/New_York" },
  { build: 310002, device: "cheetah", locale: "en-GB", tz: "Europe/London" },
  { build: 306015, device: "dm3q", locale: "fr-FR", tz: "Europe/Paris" },
  { build: 312001, device: "panther", locale: "de-DE", tz: "Europe/Berlin" },
  { build: 307008, device: "bluejay", locale: "tr-TR", tz: "Europe/Istanbul" },
];

function getDeviceProfile(index) {
  return DEVICE_PROFILES[index % DEVICE_PROFILES.length];
}

function buildSuperProperties(profile) {
  const obj = {
    os: "Android",
    browser: "Discord Android",
    device: profile.device,
    system_locale: profile.locale,
    client_version: `${profile.build}`,
    release_channel: "stable",
    client_build_number: profile.build,
    design_id: 0,
  };
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

// فحص اسم مستخدم بدون توكن (fallback)
function checkUsernameUnauthed(username) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ username });
    const options = {
      hostname: "discord.com",
      path: "/api/v9/unique-username/username-attempt-unauthed",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) {
            // taken: true = مأخوذ | taken: false = متاح
            resolve({ status: "ok", taken: json.taken === true });
          } else if (res.statusCode === 400) {
            // اسم غير صالح أو محجوز من Discord
            resolve({ status: "ok", taken: true, reserved: true });
          } else if (res.statusCode === 429) {
            resolve({
              status: "ratelimit",
              retryAfter: json.retry_after || 10,
            });
          } else {
            resolve({ status: "error", code: res.statusCode });
          }
        } catch {
          resolve({ status: "error", code: res.statusCode });
        }
      });
    });
    req.on("error", () => resolve({ status: "network_error" }));
    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ status: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

// فحص اسم مستخدم واحد بتوكن محدد
function checkUsername(username, token, tokenIndex) {
  // إذا لا يوجد توكن → استخدم الـ endpoint بدون مصادقة
  if (!token) return checkUsernameUnauthed(username);

  return new Promise((resolve) => {
    const profile = getDeviceProfile(tokenIndex);
    const ua = `Discord-Android/${profile.build};RNA`;
    const superProps = buildSuperProperties(profile);

    const body = JSON.stringify({ username });
    const options = {
      hostname: "discord.com",
      path: "/api/v9/users/@me/pomelo-attempt",
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": ua,
        "X-Super-Properties": superProps,
        "X-Discord-Locale": profile.locale,
        "X-Discord-Timezone": profile.tz,
        "Accept-Language": profile.locale + ",en;q=0.9",
        Connection: "keep-alive",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) {
            // taken: false = متاح ✔ | taken: true = مأخوذ ✘
            resolve({ status: "ok", taken: json.taken === true });
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ status: "bad_token", code: res.statusCode });
          } else if (res.statusCode === 429) {
            const retryAfter = json.retry_after || 5;
            resolve({ status: "ratelimit", retryAfter });
          } else {
            resolve({ status: "error", code: res.statusCode, body: data });
          }
        } catch {
          resolve({ status: "error", code: res.statusCode });
        }
      });
    });

    req.on("error", () => resolve({ status: "network_error" }));
    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ status: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  توليد أسماء المستخدمين
// ═══════════════════════════════════════════════════════════
const ALPHA_NUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const VALID_MID = "abcdefghijklmnopqrstuvwxyz0123456789._";

// هل الاسم صالح لمعايير Discord الجديدة؟
function isValidUsername(name) {
  if (name.length < 2 || name.length > 32) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.startsWith("_") || name.endsWith("_")) return false;
  if (
    name.includes("..") ||
    name.includes("__") ||
    name.includes("._") ||
    name.includes("_.")
  )
    return false;
  return /^[a-z0-9._]+$/.test(name);
}

// توليد جميع تركيبات 3-أحرف صالحة
function* gen3CharUsernames(checkedSet) {
  for (const a of ALPHA_NUM) {
    for (const b of VALID_MID) {
      for (const c of ALPHA_NUM) {
        const name = a + b + c;
        if (isValidUsername(name) && !checkedSet.has(name)) {
          yield name;
        }
      }
    }
  }
}

// توليد أسماء بناءً على نمط مخصص (#=عشوائي) — بدون أي فلترة
function* genPatternUsernames(pattern, checkedSet) {
  const positions = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "#") positions.push(i);
  }

  if (positions.length === 0) {
    // نمط ثابت — فحص واحد فقط
    if (!checkedSet.has(pattern)) yield pattern;
    return;
  }

  // توليد جميع التركيبات لمواضع الـ #
  const total = Math.pow(ALPHA_NUM.length, positions.length);
  for (let i = 0; i < total; i++) {
    let n = i;
    const chars = [];
    for (let p = 0; p < positions.length; p++) {
      chars.push(ALPHA_NUM[n % ALPHA_NUM.length]);
      n = Math.floor(n / ALPHA_NUM.length);
    }
    const arr = pattern.split("");
    for (let p = 0; p < positions.length; p++) {
      arr[positions[p]] = chars[p];
    }
    const name = arr.join("");
    if (!checkedSet.has(name)) yield name;
  }
}

// ═══════════════════════════════════════════════════════════
//  أدوات مساعدة
// ═══════════════════════════════════════════════════════════
function readLines(filePath, skipComments = false) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (skipComments && (l.startsWith("#") || l.startsWith("//")))
        return false;
      return true;
    });
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + "\n", "utf-8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

// إرسال رسالة تليجرام
function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

// شريط التقدم
function progressBar(current, total, width = 28) {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.min(Math.round(pct * width), width);
  return (
    "[" +
    "█".repeat(filled) +
    "░".repeat(width - filled) +
    "]" +
    ` ${current}/${total} (${Math.round(pct * 100)}%)`
  );
}

// ═══════════════════════════════════════════════════════════
//  واجهة المستخدم
// ═══════════════════════════════════════════════════════════
function printBanner() {
  console.clear();
  console.log(
    C.cyan +
      C.bold +
      `
╔══════════════════════════════════════════════════════╗
║      Discord Username Hunter  v4.0  (Node.js)        ║
║         فاحص أسماء المستخدمين — مع تليجرام          ║
╚══════════════════════════════════════════════════════╝
` +
      C.reset,
  );
}

// ═══════════════════════════════════════════════════════════
//  البرنامج الرئيسي
// ═══════════════════════════════════════════════════════════
async function main() {
  printBanner();

  // ── تحقق من ملف التوكنات ──────────────────────────────
  if (!fs.existsSync(TOKENS_FILE)) {
    fs.writeFileSync(
      TOKENS_FILE,
      "# ضع توكنات Discord هنا — كل توكن في سطر\n",
      "utf-8",
    );
    console.log(
      C.yellow +
        `⚠  ملف tokens.txt غير موجود — تم إنشاؤه.\n   أضف التوكنات في: ${TOKENS_FILE}` +
        C.reset,
    );
    process.exit(0);
  }

  const tokens = readLines(TOKENS_FILE, true);
  if (tokens.length === 0) {
    console.log(C.red + "✘  tokens.txt فارغ! أضف التوكنات أولاً." + C.reset);
    process.exit(1);
  }
  console.log(
    C.green + `✔  توكنات محملة: ${C.bold}${tokens.length}${C.reset}` + "\n",
  );

  // ── تحميل الأسماء المفحوصة مسبقاً ────────────────────
  const checkedSet = new Set(
    readLines(UNAVAILABLE_FILE, false).map((l) => l.split("|")[0].trim()),
  );
  const availableSet = new Set(readLines(AVAILABLE_FILE, false));
  for (const a of availableSet) checkedSet.add(a);

  if (checkedSet.size > 0) {
    console.log(
      C.dim +
        `⊖  أسماء مفحوصة مسبقاً (مُتخطّاة): ${checkedSet.size}` +
        C.reset +
        "\n",
    );
  }

  // ════════════════════════════════════════════════════════
  //  اختيار النمط  ← الخيار الوحيد
  // ════════════════════════════════════════════════════════
  console.log(C.bold + C.cyan + "اختر نمط الفحص:" + C.reset);
  console.log(
    `  ${C.yellow}[1]${C.reset} ${C.bold}فحص جميع الأسماء الثلاثية الصالحة${C.reset}`,
  );
  console.log(
    `       ${C.dim}يولّد جميع التركيبات الممكنة من 3 أحرف/أرقام (36³ = 46,656 اسم تقريباً)${C.reset}`,
  );
  console.log(`  ${C.yellow}[2]${C.reset} ${C.bold}نمط مخصص${C.reset}`);
  console.log(
    `       ${C.dim}مثال: ##oo → يفحص كل التركيبات (00oo, 01oo, ... zzoo)${C.reset}`,
  );
  console.log(
    `       ${C.dim}الرمز # = أي حرف أو رقم (a-z, 0-9) | الحروف الثابتة تبقى كما هي${C.reset}\n`,
  );

  let modeChoice = await prompt(C.cyan + "أدخل رقم النمط (1 أو 2): " + C.reset);
  while (!["1", "2"].includes(modeChoice)) {
    modeChoice = await prompt(
      C.red + "اختيار غير صحيح، أدخل 1 أو 2: " + C.reset,
    );
  }

  let pattern = "";
  if (modeChoice === "2") {
    while (true) {
      pattern = await prompt(
        C.cyan + "\nأدخل النمط (# = عشوائي، مثال: ##oo أو a#b#): " + C.reset,
      );
      pattern = pattern.toLowerCase().trim();

      if (!pattern) {
        console.log(C.red + "✘  النمط فارغ! أعد المحاولة." + C.reset);
        continue;
      }

      // ── تحقق أساسي فقط (أحرف + طول) ───────────────────
      const errors = [];
      if (/[^a-z0-9._#]/.test(pattern))
        errors.push("أحرف غير مقبولة (المقبول: a-z 0-9 . _ #)");
      if (pattern.length > 32) errors.push("النمط طويل جداً (أقصاه 32 حرف)");

      if (errors.length > 0) {
        console.log(C.red + "✘  " + errors.join(" | ") + C.reset);
        continue;
      }

      // ── حساب عدد الأسماء التي سيتم فحصها ──────────────
      const hashCount = (pattern.match(/#/g) || []).length;
      const totalCombinations = Math.pow(ALPHA_NUM.length, hashCount);
      const SAMPLE_LIMIT = 5000; // الحد الأقصى لفحص كامل

      let validCount = 0;
      let alreadyChecked = 0;
      let sampleSize = 0;

      for (const name of genPatternUsernames(pattern, new Set())) {
        validCount++;
        if (checkedSet.has(name)) alreadyChecked++;
        sampleSize++;
        if (sampleSize >= SAMPLE_LIMIT) break; // توقف بعد عينة
      }

      // تقدير إذا قطعنا مبكراً
      const isEstimate =
        sampleSize >= SAMPLE_LIMIT && totalCombinations > SAMPLE_LIMIT;
      let validEstimate = validCount;
      let alreadyEstimate = alreadyChecked;
      if (isEstimate) {
        const ratio = validCount / sampleSize;
        validEstimate = Math.round(ratio * totalCombinations);
        alreadyEstimate = Math.round(
          (alreadyChecked / sampleSize) * totalCombinations,
        );
      }

      const toCheck = Math.max(0, validEstimate - alreadyEstimate);

      const estLabel = isEstimate ? "~" : "";
      console.log(
        "\n" +
          C.green +
          `✔  النمط سيولّد: ${C.bold}${estLabel}${validEstimate.toLocaleString()}${C.reset}${C.green} تركيبة` +
          C.reset,
      );
      if (alreadyEstimate > 0) {
        console.log(
          C.dim +
            `   مفحوص مسبقاً: ${estLabel}${alreadyEstimate.toLocaleString()} → سيُفحص ${estLabel}${toCheck.toLocaleString()} جديد` +
            C.reset,
        );
      }
      if (toCheck === 0 && alreadyEstimate > 0) {
        console.log(
          C.yellow + "⚠  جميع أسماء هذا النمط مفحوصة مسبقاً!" + C.reset,
        );
        const recheck = await prompt(
          C.cyan + "   هل تريد إعادة فحصها؟ (y/n): " + C.reset,
        );
        if (["y", "yes", "ن", "نعم"].includes(recheck.toLowerCase())) {
          checkedSet.clear(); // امسح السجل لإعادة الفحص
          console.log(C.green + "✔  سيتم إعادة فحص الجميع." + C.reset);
        } else {
          continue; // اطلب نمط آخر
        }
      }
      break;
    }
  }

  // ── اختيار التأخير بين الطلبات ───────────────────────
  console.log("\n" + C.bold + "التأخير بين الطلبات (ثواني):" + C.reset);
  console.log(C.dim + "• كلما زاد التأخير، قلّ احتمال الحظر" + C.reset);
  console.log(
    C.dim + "• الحد الأدنى الآمن: 1 ثانية | الموصى به: 3-5 ثواني" + C.reset,
  );

  let delayInput = await prompt(
    C.cyan + "\nأدخل التأخير بالثواني (مثال: 2): " + C.reset,
  );
  let delaySeconds = parseFloat(delayInput);
  while (isNaN(delaySeconds) || delaySeconds < 0.5) {
    delayInput = await prompt(C.red + "أدخل رقماً صحيحاً ≥ 0.5: " + C.reset);
    delaySeconds = parseFloat(delayInput);
  }
  const delayMs = Math.round(delaySeconds * 1000);

  // ── ملخص قبل البدء ────────────────────────────────────
  console.log(
    "\n" +
      C.bold +
      "─────────────────────────────────────────────────" +
      C.reset,
  );
  const modeLabel =
    modeChoice === "1"
      ? "جميع الأسماء الثلاثية"
      : `نمط: ${C.bold}${pattern}${C.reset}`;
  console.log(`النمط    : ${modeLabel}`);
  console.log(`التأخير  : ${C.bold}${delaySeconds}ث${C.reset} بين كل طلب`);
  console.log(
    `التوكنات : ${C.bold}${tokens.length}${C.reset} توكن (يتناوب بينهم)`,
  );
  console.log(
    `الإيقاع  : كل دورة كاملة = ${(delaySeconds * tokens.length).toFixed(1)}ث على نفس التوكن`,
  );
  console.log(
    C.bold +
      "─────────────────────────────────────────────────" +
      C.reset +
      "\n",
  );

  const confirm = await prompt(C.cyan + "ابدأ الفحص؟ (y/n): " + C.reset);
  if (!["y", "yes", "ن", "نعم"].includes(confirm.toLowerCase())) {
    console.log(C.dim + "إلغاء." + C.reset);
    process.exit(0);
  }

  // ════════════════════════════════════════════════════════
  //  بدء الفحص
  // ════════════════════════════════════════════════════════
  const gen =
    modeChoice === "1"
      ? gen3CharUsernames(checkedSet)
      : genPatternUsernames(pattern, checkedSet);

  const stats = {
    total: 0,
    available: 0,
    taken: 0,
    errors: 0,
    badTokens: new Set(),
  };
  const startTime = Date.now();
  let tokenIndex = 0;

  // إشعار بدء التليجرام
  await sendTelegram(
    `🚀 <b>بدء فحص أسماء Discord</b>\n\n` +
      `🎯 النمط: ${modeChoice === "1" ? "جميع الثلاثيات" : pattern}\n` +
      `⚡ التأخير: ${delaySeconds}ث بين كل طلب\n` +
      `🔑 عدد التوكنات: ${tokens.length}`,
  );

  console.log(
    "\n" +
      C.bold +
      "─── جاري الفحص ──────────────────────────────────" +
      C.reset,
  );

  let lastNotifyTime = Date.now();

  for (const username of gen) {
    stats.total++;

    // تخطي التوكنات المعطلة
    while (
      tokens.length > 0 &&
      stats.badTokens.has(tokenIndex % tokens.length) &&
      stats.badTokens.size < tokens.length
    ) {
      tokenIndex++;
    }

    let currentTokenIdx = -1;
    let token = null;

    if (tokens.length === 0 || stats.badTokens.size >= tokens.length) {
      // لا توكنات → استخدام الـ endpoint بدون مصادقة (أبطأ لكن يعمل)
      if (stats.total === 1 && stats.badTokens.size >= tokens.length) {
        process.stdout.write("\r" + " ".repeat(80) + "\r");
        console.log(
          C.yellow +
            "⚠  جميع التوكنات معطّلة — يستمر الفحص بدون توكن (سيكون أبطأ)" +
            C.reset,
        );
      }
    } else {
      currentTokenIdx = tokenIndex % tokens.length;
      token = tokens[currentTokenIdx];
    }

    // عرض الحالة
    const tokenLabel = token
      ? `⚡توكن ${currentTokenIdx + 1}/${tokens.length}`
      : `⚡بدون توكن`;
    process.stdout.write(
      `\r${C.dim}[${stats.total}]${C.reset} فحص: ${C.bold}${username.padEnd(20)}${C.reset}` +
        `  ✔${C.green}${stats.available}${C.reset}  ✘${C.dim}${stats.taken}${C.reset}  ` +
        `${tokenLabel}   `,
    );

    // الفحص الفعلي
    const result = await checkUsername(username, token, currentTokenIdx);

    // ── معالجة النتيجة ─────────────────────────────────────
    if (result.status === "ok") {
      if (!result.taken) {
        // ✔ الاسم متاح!
        stats.available++;
        appendLine(AVAILABLE_FILE, username);
        checkedSet.add(username);
        process.stdout.write("\r" + " ".repeat(80) + "\r");
        console.log(C.green + C.bold + `✔ متاح! → ${username}` + C.reset);
        // إشعار تليجرام فوري
        await sendTelegram(
          `🎉 <b>اسم متاح وجدناه!</b>\n\n` +
            `👤 Username: <code>${username}</code>\n` +
            `📊 إجمالي المفحوص: ${stats.total} | متاح: ${stats.available}`,
        );
      } else {
        // ✘ الاسم مأخوذ أو محجوز
        stats.taken++;
        appendLine(
          UNAVAILABLE_FILE,
          username + (result.reserved ? " | reserved" : " | taken"),
        );
        checkedSet.add(username);
      }
    } else if (result.status === "bad_token") {
      // توكن معطّل — يُحفظ ويُنتقل للتوكن التالي
      stats.badTokens.add(currentTokenIdx);
      process.stdout.write("\r" + " ".repeat(80) + "\r");
      console.log(
        C.red + `✘  توكن معطّل (#${currentTokenIdx + 1}) — يُتخطّى` + C.reset,
      );
      // لا نحفظ الاسم كـ "مفحوص" حتى يُفحص بتوكن صالح
      // لكن نتجنب infinite loop: لو كل التوكنات معطّلة نحفظه
      if (stats.badTokens.size >= tokens.length) {
        appendLine(UNAVAILABLE_FILE, username + " | all_tokens_bad");
        checkedSet.add(username);
      }
    } else if (result.status === "ratelimit") {
      // تجاوز حد الطلبات — ننتظر المدة المطلوبة ثم نكمل
      const waitSec = result.retryAfter || 5;
      process.stdout.write("\r" + " ".repeat(80) + "\r");
      console.log(
        C.yellow + `⚠  Rate Limited — ينتظر ${waitSec}ث إضافية...` + C.reset,
      );
      // نحفظ الاسم للمراجعة لاحقاً (أُفضّل عدم حفظه كـ unavailable)
      // ننتظر المدة الإضافية فقط (بعدها سيأتي الـ sleep العادي أيضاً)
      await sleep(waitSec * 1000);
    } else {
      // خطأ شبكة أو غير معروف
      stats.errors++;
      appendLine(UNAVAILABLE_FILE, username + " | error_" + result.status);
      checkedSet.add(username);
    }

    // ── تقديم التوكن للدورة القادمة ───────────────────────
    if (token) tokenIndex++;

    // ══════════════════════════════════════════════════════
    //  الانتظار الإلزامي بين كل فحص وفحص — لا يُتخطّى أبداً
    //  (يوزر ← انتظار ← يوزر ← انتظار ← يوزر ...)
    // ══════════════════════════════════════════════════════
    await sleep(delayMs);

    // إشعار تليجرام تقدمي كل 500 فحص
    if (stats.total % 500 === 0 && Date.now() - lastNotifyTime > 60000) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      await sendTelegram(
        `📊 <b>تحديث تقدم الفحص</b>\n\n` +
          `🔢 مفحوص: <b>${stats.total}</b>\n` +
          `✅ متاح: <b>${stats.available}</b>\n` +
          `❌ مأخوذ: <b>${stats.taken}</b>\n` +
          `⏱️ الوقت: ${Math.floor(elapsed / 60)}د ${elapsed % 60}ث`,
      );
      lastNotifyTime = Date.now();
    }
  }

  // ════════════════════════════════════════════════════════
  //  النتائج النهائية
  // ════════════════════════════════════════════════════════
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const timeStr =
    elapsed > 60
      ? `${Math.floor(elapsed / 60)}د ${elapsed % 60}ث`
      : `${elapsed}ث`;

  process.stdout.write("\r" + " ".repeat(80) + "\r");
  console.log(
    "\n" +
      C.bold +
      "─── النتائج النهائية ────────────────────────────" +
      C.reset,
  );
  console.log(C.green + `✔  متاح     : ${stats.available}` + C.reset);
  console.log(C.dim + `✘  مأخوذ    : ${stats.taken}` + C.reset);
  console.log(C.yellow + `⚠  أخطاء    : ${stats.errors}` + C.reset);
  console.log(`⏱  الوقت    : ${timeStr}`);
  console.log("─────────────────────────────────────────────────");
  console.log(`📁 الأسماء المتاحة    → ${AVAILABLE_FILE}`);
  console.log(`📁 الأسماء المفحوصة  → ${UNAVAILABLE_FILE}`);

  await sendTelegram(
    `📊 <b>تقرير الفحص النهائي</b>\n\n` +
      `✅ متاح    : <b>${stats.available}</b>\n` +
      `❌ مأخوذ   : <b>${stats.taken}</b>\n` +
      `⚠️ أخطاء   : <b>${stats.errors}</b>\n` +
      `🔢 إجمالي  : <b>${stats.total}</b>\n` +
      `⏱️ الوقت   : <b>${timeStr}</b>\n\n` +
      `📁 النتائج في: available_usernames.txt`,
  );

  console.log("\n" + C.green + C.bold + "✔  اكتمل الفحص!" + C.reset + "\n");
}

main().catch((err) => {
  console.error(C.red + "خطأ فادح: " + err.message + C.reset);
  process.exit(1);
});
