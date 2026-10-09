// ElevenLabs image generator driven through a real browser session (cookies/session) — no public API key.
import express from "express";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const DATA = process.env.DATA_DIR || __dirname;
const DL_DIR = path.join(DATA, "downloads");
const STATE_FILE = path.join(DATA, "storageState.json");
const COOKIE_FILE = path.join(DATA, "cookies.json");
const STUDIO_URL = process.env.ELEVEN_URL || CFG.url;
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
fs.mkdirSync(DL_DIR, { recursive: true });
if (!fs.existsSync(COOKIE_FILE) && fs.existsSync(path.join(__dirname, "cookies.json")))
  fs.copyFileSync(path.join(__dirname, "cookies.json"), COOKIE_FILE);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const optLabel = (o) => (typeof o === "string" ? o : o.label);
const optMatch = (o) => (typeof o === "string" ? esc(o) : o.match);
const SIGNIN_RE = /sign-?in|log-?in|sign-?up/i;

/* =====================================================================
   cookies <-> Playwright
   ===================================================================== */
const SS_IN = { strict: "Strict", lax: "Lax", no_restriction: "None" };
const SS_OUT = { Strict: "strict", Lax: "lax", None: "no_restriction" };

function toPlaywrightCookies(list) {
  return list.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.hostOnly ? c.domain.replace(/^\./, "") : c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: SS_IN[c.sameSite] || "Lax",
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
  }));
}
function fromPlaywrightCookies(list) {
  return list.map((c) => ({
    domain: c.domain,
    hostOnly: !c.domain.startsWith("."),
    httpOnly: c.httpOnly,
    name: c.name,
    path: c.path,
    sameSite: SS_OUT[c.sameSite] || "unspecified",
    secure: c.secure,
    session: c.expires === -1,
    ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
    storeId: "0",
    value: c.value,
  }));
}

/* =====================================================================
   browser lifecycle
   ===================================================================== */
let browser, context, page;
const session = { loggedIn: null, checkedAt: 0, error: "" };

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  log("launching chromium…");
  browser = await chromium.launch({
    headless: CFG.headless,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  browser.on("disconnected", () => { browser = context = page = undefined; });
  return browser;
}

async function resetBrowserContext() {
  try { await context?.close(); } catch {}
  context = page = undefined;
}

async function boot() {
  if (page && !page.isClosed()) return page;
  const b = await getBrowser();
  if (!context) {
    const opts = { viewport: { width: 1440, height: 1000 }, locale: "en-US", userAgent: UA };
    if (fs.existsSync(STATE_FILE)) {
      log("session: storageState.json");
      context = await b.newContext({ ...opts, storageState: STATE_FILE });
    } else {
      log("session: cookies.json");
      context = await b.newContext(opts);
      if (fs.existsSync(COOKIE_FILE))
        await context.addCookies(toPlaywrightCookies(JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"))));
    }
  }
  page = await context.newPage();
  page.on("crash", () => { log("page crashed"); page = undefined; });
  return page;
}

async function resetPage() {
  try { await page?.close(); } catch {}
  page = undefined;
}

// keep refreshed tokens (Firebase refresh etc.) so the session lasts
async function saveSession() {
  if (!context) return;
  try {
    await context.storageState({ path: STATE_FILE, indexedDB: true });
  } catch {
    try { await context.storageState({ path: STATE_FILE }); } catch {}
  }
}

async function openStudio({ fresh = false } = {}) {
  const p = await boot();
  if (fresh || !p.url().startsWith(STUDIO_URL.split("/app/")[0])) {
    await p.goto(STUDIO_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  session.checkedAt = Date.now();
  if (SIGNIN_RE.test(new URL(p.url()).pathname)) {
    session.loggedIn = false;
    session.error = "الجلسة منتهية — سجّل الدخول عن بُعد";
    throw new Error("AUTH: الجلسة منتهية أو الكوكيز غير صالحة. افتح «دخول عن بُعد» في الواجهة وسجّل الدخول مرة واحدة.");
  }
  session.loggedIn = true;
  session.error = "";
  for (const name of [/accept all|allow all/i, /got it|dismiss|not now|maybe later/i]) {
    await p.getByRole("button", { name }).first().click({ timeout: 600 }).catch(() => {});
  }
  return p;
}

/* =====================================================================
   UI automation helpers
   ===================================================================== */
async function clickMatch(p, src, { exact = true } = {}) {
  const re = new RegExp(exact ? `^\\s*(?:${src})\\s*$` : src, "i");
  for (const role of ["option", "menuitemradio", "menuitem", "radio", "tab", "button"]) {
    const el = p.getByRole(role, { name: re }).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  if (exact) {
    const el = p.getByText(re).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function chooseFromDropdown(p, triggerPattern, optionSrc, { exact = true } = {}) {
  const trigs = p.locator("button, [role=combobox]").filter({ hasText: new RegExp(triggerPattern, "i") });
  const n = Math.min(await trigs.count().catch(() => 0), 6);
  for (let i = 0; i < n; i++) {
    const t = trigs.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    await t.click({ timeout: 2000 }).catch(() => {});
    await sleep(350);
    if (await clickMatch(p, optionSrc, { exact })) {
      await sleep(200);
      await p.keyboard.press("Escape").catch(() => {});
      return true;
    }
    await p.keyboard.press("Escape").catch(() => {});
  }
  return false;
}

async function applySetting(p, kind, value, applied, warnings) {
  if (!value) return;
  const conf = CFG[kind];
  const opt = conf.options.find((o) => optLabel(o).toLowerCase() === String(value).toLowerCase());
  const src = opt ? optMatch(opt) : esc(String(value));
  if (await clickMatch(p, src)) {
    await p.keyboard.press("Escape").catch(() => {}); // close popover if we clicked the trigger itself
    return void (applied[kind] = value);
  }
  if (await chooseFromDropdown(p, conf.triggerPattern, src)) return void (applied[kind] = value);
  warnings.push(`تعذّر ضبط ${kind} = ${value}`);
}

async function selectModel(p, label, applied, warnings) {
  const m = CFG.models.find((x) => x.label === label) || CFG.models[0];
  const current = p.locator("button, [role=combobox]").filter({ hasText: new RegExp(m.match, "i") }).first();
  if (await current.isVisible().catch(() => false)) {
    const txt = ((await current.innerText().catch(() => "")) || "").trim();
    if (txt.length < 60) return void (applied.model = m.label);
  }
  for (const trig of ["GPT Image|Flux|Nano Banana|Seedream|Veo|Kling|model", "image"]) {
    if (await chooseFromDropdown(p, trig, m.match, { exact: false })) return void (applied.model = m.label);
  }
  warnings.push(`تعذّر تأكيد اختيار الموديل ${m.label}`);
}

async function fillPrompt(p, prompt) {
  const ta = p.locator("textarea:visible").first();
  if (await ta.count()) {
    await ta.click();
    await ta.fill(prompt);
    return;
  }
  const ce = p.locator('[contenteditable="true"]:visible, .ProseMirror:visible').first();
  await ce.click();
  await p.keyboard.press("Control+A");
  await p.keyboard.insertText(prompt);
}

async function visibleImgSrcs(p) {
  return p.evaluate(() =>
    [...document.images]
      .filter((i) => i.naturalWidth >= 256 && i.naturalHeight >= 256 && i.offsetParent)
      .map((i) => i.currentSrc || i.src)
  );
}

async function fetchInPage(p, src) {
  const r = await p.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), type: res.headers.get("content-type") || "" };
  }, src);
  return { buf: Buffer.from(r.b64, "base64"), type: r.type };
}

const extOf = (type, buf) =>
  /png/.test(type) || buf.subarray(1, 4).toString() === "PNG" ? "png" : /webp/.test(type) ? "webp" : /jpe?g/.test(type) ? "jpg" : "png";

function findGen(node, id, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (!Array.isArray(node) && node.id === id && node.status) return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = findGen(v, id, depth + 1);
    if (f) return f;
  }
  return null;
}

async function listControls(p) {
  return p.evaluate(() =>
    [...document.querySelectorAll("button,[role=combobox],[role=tab],[role=radio],[role=option],textarea,[contenteditable=true]")]
      .filter((e) => e.offsetParent)
      .map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("role") || ""}] ${(e.innerText || e.getAttribute("aria-label") || e.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 70)}`)
  );
}

async function captureFailure(msg) {
  try {
    if (!page || page.isClosed()) return;
    await page.screenshot({ path: path.join(DL_DIR, "last_error.png") });
    fs.writeFileSync(
      path.join(DL_DIR, "last_error.json"),
      JSON.stringify({ at: new Date().toISOString(), error: msg, url: page.url(), controls: await listControls(page) }, null, 2)
    );
  } catch {}
}

/* =====================================================================
   one generation
   ===================================================================== */
async function generate({ prompt, model, aspect, resolution, strength }, report) {
  const p = await openStudio({ fresh: true });
  const applied = {};
  const warnings = [];
  const job = { id: null, postUrl: null, headers: null, done: null, failed: null };
  let submitted = false;

  const handleGen = (g) => {
    const st = String(g.status || "").toLowerCase();
    if (st === "completed" && (g.content_url || g.url)) job.done = { url: g.content_url || g.url, mime: g.content_mime_type || "" };
    else if (st === "failed") job.failed = `${g.failure_reason || "failed"}${g.error_message ? ": " + g.error_message : ""}`;
  };

  const onResp = async (r) => {
    try {
      const req = r.request();
      const ct = r.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const txt = await r.text();
      if (txt.length > 3e6) return;
      let j;
      try { j = JSON.parse(txt); } catch { return; }
      if (!job.id && req.method() === "POST" && j && typeof j.id === "string" && /^(pending|generating|queued|processing)$/i.test(j.status || "")) {
        job.id = j.id;
        job.postUrl = r.url().split("?")[0];
        job.headers = await req.allHeaders().catch(() => null);
        log("generation id:", j.id, "←", job.postUrl);
        report?.("تم إرسال الطلب إلى ElevenLabs");
        return;
      }
      if (job.id) { const g = findGen(j, job.id); if (g) handleGen(g); }
    } catch {}
  };

  try {
    const before = new Set(await visibleImgSrcs(p));
    report?.("ضبط الإعدادات");
    await clickMatch(p, "image").catch(() => {});
    await selectModel(p, model, applied, warnings);
    await applySetting(p, "aspect", aspect, applied, warnings);
    await applySetting(p, "resolution", resolution, applied, warnings);
    await applySetting(p, "strength", strength, applied, warnings);
    await fillPrompt(p, prompt);

    p.on("response", onResp);
    const btn = p.getByRole("button", { name: new RegExp(CFG.generateButton, "i") }).last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 8000 }).catch(() => { throw new Error("زر Generate غير قابل للضغط (رصيد غير كافٍ أو إعداد ناقص)"); });
    } else {
      await p.keyboard.press("Control+Enter");
    }
    submitted = true;
    report?.("جارٍ التوليد…");
    log("clicked generate", applied);

    const t0 = Date.now();
    let lastPoll = 0;
    let result = null;
    while (Date.now() - t0 < CFG.timeoutMs) {
      await sleep(1500);
      if (job.failed) throw new Error("فشل التوليد: " + job.failed);

      if (job.id && !job.done && job.headers && Date.now() - lastPoll > 3000) {
        lastPoll = Date.now();
        const h = Object.fromEntries(Object.entries(job.headers).filter(([k]) => !/^(:|host$|content-length$|cookie$|content-type$)/i.test(k)));
        const r = await context.request.get(`${job.postUrl.replace(/\/$/, "")}/${job.id}`, { headers: h, timeout: 15000 }).catch(() => null);
        if (r?.ok()) { const j = await r.json().catch(() => null); if (j) handleGen(findGen(j, job.id) || j); }
      }

      if (job.done) {
        report?.("تنزيل الصورة");
        let got = null;
        const r = await context.request.get(job.done.url, { timeout: 60000 }).catch(() => null);
        if (r?.ok()) got = { buf: await r.body(), type: r.headers()["content-type"] || job.done.mime };
        else got = await fetchInPage(p, job.done.url).catch(() => null);
        if (got?.buf?.length > 1000) { result = { ...got, via: "api-status" }; break; }
      }

      if (!job.id && Date.now() - t0 > 45000) {
        const now = (await visibleImgSrcs(p)).filter((s) => !before.has(s));
        if (now.length) {
          const got = await fetchInPage(p, now[0]).catch(() => null);
          if (got?.buf?.length > 20000) { result = { ...got, via: "dom" }; break; }
        }
      }
    }
    if (!result) throw new Error("TIMEOUT: لم تظهر النتيجة. راجع /api/debug أو downloads/last_error.json");

    const name = `img_${Date.now()}.${extOf(result.type, result.buf)}`;
    fs.writeFileSync(path.join(DL_DIR, name), result.buf);
    log("saved", name, result.buf.length, "bytes via", result.via);
    return { url: `/files/${name}`, applied, warnings, via: result.via, generationId: job.id };
  } catch (e) {
    e.submitted = submitted;
    throw e;
  } finally {
    p.off("response", onResp);
  }
}

/* =====================================================================
   job queue (async API: POST returns jobId, client polls)
   ===================================================================== */
let chain = Promise.resolve();
let pending = 0;
function enqueue(fn) {
  pending++;
  const run = chain.then(fn);
  chain = run.catch(() => {}).finally(() => { pending--; });
  return run;
}

const jobs = new Map();
setInterval(() => {
  for (const [id, j] of jobs) if (Date.now() - j.createdAt > 3600e3) jobs.delete(id);
}, 600e3).unref();

async function runJob(job) {
  job.state = "running";
  const report = (m) => job.log.push(m);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      job.result = await generate(job.params, report);
      job.state = "done";
      saveSession();
      return;
    } catch (e) {
      job.error = e.message;
      await captureFailure(e.message);
      const final = e.submitted || /^(AUTH|TIMEOUT|فشل التوليد|زر Generate)/.test(e.message) || attempt === 2;
      if (final) { job.state = "failed"; return; }
      report("خطأ في الواجهة — إعادة المحاولة");
      await resetPage();
    }
  }
}

/* =====================================================================
   HTTP server + auth
   ===================================================================== */
const app = express();

function authOk(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const dec = Buffer.from(h.slice(6), "base64").toString();
  const pw = dec.slice(dec.indexOf(":") + 1);
  const a = crypto.createHash("sha256").update(pw).digest();
  const b = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
app.use((req, res, next) => {
  if (req.path === "/health" || authOk(req)) return next();
  res.set("WWW-Authenticate", 'Basic realm="el-img"').status(401).send("auth required");
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(DL_DIR));

app.get("/health", (_q, r) => r.json({ ok: true, pending, browser: !!browser?.isConnected() }));

app.post("/api/generate", (req, res) => {
  const { prompt, model, aspect, resolution, strength } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "prompt مطلوب" });
  if (loginActive) return res.status(409).json({ error: "جلسة دخول عن بُعد مفتوحة — أنهِها أولاً" });
  const id = crypto.randomUUID();
  const job = {
    id, state: "queued", createdAt: Date.now(), log: [], result: null, error: null,
    params: { prompt: String(prompt).trim(), model, aspect, resolution, strength },
  };
  jobs.set(id, job);
  enqueue(() => runJob(job)).catch((e) => { job.state = "failed"; job.error = e.message; });
  res.json({ jobId: id });
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "غير موجود" });
  const position = j.state === "queued" ? [...jobs.values()].filter((x) => x.state === "queued" && x.createdAt <= j.createdAt).length : 0;
  res.json({
    state: j.state, position, log: j.log, result: j.result, error: j.error,
    errorShot: j.state === "failed" ? "/files/last_error.png" : undefined,
  });
});

app.get("/api/options", (_q, r) =>
  r.json({
    models: CFG.models.map((m) => m.label),
    aspect: CFG.aspect.options.map(optLabel),
    resolution: CFG.resolution.options.map(optLabel),
    strength: CFG.strength.options.map(optLabel),
  })
);

app.get("/api/history", (_q, r) => {
  const files = fs.readdirSync(DL_DIR).filter((f) => /^img_.*\.(png|webp|jpg)$/.test(f)).sort().reverse().slice(0, 12);
  r.json(files.map((f) => `/files/${f}`));
});

// session status: cached while a job runs; ?fresh=1 re-verifies by opening the studio
app.get("/api/status", async (req, res) => {
  const hasSaved = fs.existsSync(STATE_FILE) || fs.existsSync(COOKIE_FILE);
  if (req.query.fresh && pending === 0 && !loginActive) {
    try { await enqueue(() => openStudio({ fresh: true })); } catch {}
  }
  res.json({ loggedIn: session.loggedIn, checkedAt: session.checkedAt, error: session.error, hasSaved, busy: pending > 0, loginActive });
});

app.post("/api/cookies", async (req, res) => {
  try {
    const list = typeof req.body.cookies === "string" ? JSON.parse(req.body.cookies) : req.body.cookies;
    if (!Array.isArray(list) || !list.length) throw new Error("JSON غير صالح");
    await enqueue(async () => {
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(list, null, 2));
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
      await resetBrowserContext();
      session.loggedIn = null;
    });
    res.json({ ok: true, count: list.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/debug", async (_q, res) => {
  try {
    res.json(
      await enqueue(async () => {
        const p = await openStudio();
        await p.screenshot({ path: path.join(DL_DIR, "debug.png") });
        return { url: p.url(), title: await p.title(), screenshot: "/files/debug.png", items: await listControls(p) };
      })
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   remote login: stream the server's browser to the user, forward input,
   then store the full session (cookies + localStorage + IndexedDB)
   ===================================================================== */
let loginActive = false;
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

async function persistLoginSession(ctx) {
  try {
    await ctx.storageState({ path: STATE_FILE, indexedDB: true });
  } catch {
    await ctx.storageState({ path: STATE_FILE });
  }
  const cookies = await ctx.cookies();
  if (fs.existsSync(COOKIE_FILE) && !fs.existsSync(COOKIE_FILE + ".bak")) fs.copyFileSync(COOKIE_FILE, COOKIE_FILE + ".bak");
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(fromPlaywrightCookies(cookies), null, 2));
  // main automation context must reload from the new session
  enqueue(async () => { await resetBrowserContext(); session.loggedIn = true; session.error = ""; session.checkedAt = Date.now(); }).catch(() => {});
  log("session saved:", cookies.length, "cookies");
}

async function handleLoginSocket(ws) {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (loginActive) { send({ t: "error", v: "توجد جلسة دخول عن بُعد أخرى مفتوحة" }); return ws.close(); }
  if (pending > 0) { send({ t: "error", v: "هناك مهام توليد قيد التنفيذ — انتظر انتهاءها ثم أعد المحاولة" }); return ws.close(); }
  loginActive = true;
  const W = 820, H = 1000;
  let ctx, active, cdp, timer, closed = false, autoSaved = false, okSince = 0;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try { await ctx?.close(); } catch {}
    loginActive = false;
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  try {
    const b = await getBrowser();
    ctx = await b.newContext({ viewport: { width: W, height: H }, locale: "en-US", userAgent: UA });
    if (fs.existsSync(COOKIE_FILE)) {
      try { await ctx.addCookies(toPlaywrightCookies(JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")))); } catch {}
    }
    const attach = async (p) => {
      if (cdp) { try { await cdp.send("Page.stopScreencast"); await cdp.detach(); } catch {} }
      active = p;
      cdp = await ctx.newCDPSession(p);
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        if (ws.readyState === 1 && ws.bufferedAmount < 2e6) ws.send(Buffer.from(data, "base64"));
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
      p.on("close", () => {
        const rest = ctx.pages();
        if (active === p && rest.length) attach(rest[rest.length - 1]).catch(() => {});
      });
    };
    const first = await ctx.newPage();
    await attach(first);
    ctx.on("page", (p) => attach(p).catch(() => {})); // popups (e.g. Google sign-in)
    send({ t: "size", w: W, h: H });
    first.goto(STUDIO_URL, { waitUntil: "domcontentloaded" }).catch((e) => send({ t: "error", v: e.message }));

    ws.on("message", async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (!active || active.isClosed()) return;
        if (m.t === "click") await active.mouse.click(+m.x, +m.y);
        else if (m.t === "scroll") { await active.mouse.move(+m.x, +m.y); await active.mouse.wheel(0, +m.dy); }
        else if (m.t === "text") await active.keyboard.insertText(String(m.v));
        else if (m.t === "key") await active.keyboard.press(String(m.k));
        else if (m.t === "goto" && /^https:\/\//i.test(m.v)) await active.goto(m.v, { waitUntil: "domcontentloaded" });
        else if (m.t === "save") { await persistLoginSession(ctx); send({ t: "saved", manual: true }); }
      } catch (e) {
        send({ t: "error", v: e.message });
      }
    });

    // status ticker + auto-save once the studio is open and stable
    timer = setInterval(async () => {
      try {
        if (!active || active.isClosed()) return;
        const u = active.url();
        let ok = false;
        try { const x = new URL(u); ok = x.href.startsWith(STUDIO_URL.split("/app/")[0]) && x.pathname.startsWith("/app") && !SIGNIN_RE.test(x.pathname); } catch {}
        okSince = ok ? okSince || Date.now() : 0;
        send({ t: "state", url: u, loggedIn: ok });
        if (ok && !autoSaved && Date.now() - okSince > 5000) {
          autoSaved = true;
          await persistLoginSession(ctx);
          send({ t: "saved", manual: false });
        }
      } catch {}
    }, 1500);
  } catch (e) {
    send({ t: "error", v: e.message });
    ws.close();
    cleanup();
  }
}

/* =====================================================================
   start
   ===================================================================== */
const server = app.listen(PORT, () => {
  log(`ready → http://localhost:${PORT}  ${APP_PASSWORD ? "(password protected)" : "(WARNING: no APP_PASSWORD set)"}`);
});
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws/login") || !authOk(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => handleLoginSocket(ws));
});
const shutdown = async () => { try { await browser?.close(); } catch {} process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
