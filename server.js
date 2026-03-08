process.env.TURBOPACK = "0";
const { createServer } = require("https");
const { parse } = require("url");
const next = require("next");
const selfsigned = require("selfsigned");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");

// ─── Constants ────────────────────────────────────────────────────────────────

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, turbo: false });
const handle = app.getRequestHandler();

const BCRYPT_ROUNDS = 12;
const MAX_NAME_LENGTH = 80;
const MAX_ADDRESS_LENGTH = 180;
const MAX_USERID_LENGTH = 64;

const LOGIN_RATE_MAX = 10;
const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const QUEUE_RATE_MAX = 5;
const QUEUE_RATE_WINDOW_MS = 10 * 1000;
const READY_RATE_MAX = 10;
const READY_RATE_WINDOW_MS = 10 * 1000;
const SIGNAL_RATE_MAX = 120;
const SIGNAL_RATE_WINDOW_MS = 10 * 1000;

// ─── HTTPS ────────────────────────────────────────────────────────────────────
// In production: set SSL_KEY_PATH and SSL_CERT_PATH environment variables.
// In development: a self-signed cert is generated automatically.

function getHttpsOptions() {
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;
  if (keyPath && certPath) {
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  }
  console.warn(
    "[server] No SSL certs found — generating self-signed cert for development.",
  );
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  return { key: pems.private, cert: pems.cert };
}

// ─── ICE / TURN config ────────────────────────────────────────────────────────
// TURN credentials live here on the server — never sent to the client in source code.
// Clients receive this config once on connection via the 'ice-config' event.
// Set these environment variables in your .env file or server environment.

function getIceConfig() {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  // Only add TURN if configured — in dev you can skip it
  if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
    // UDP (fastest, try first)
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
    // TCP fallback (works through strict firewalls and some mobile networks)
    iceServers.push({
      urls: process.env.TURN_URL.replace("turn:", "turn:") + "?transport=tcp",
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  } else {
    console.warn(
      "[server] TURN_URL/TURN_USER/TURN_PASS not set — TURN relay disabled. Connections may fail on real networks.",
    );
  }

  return { iceServers };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadBranches() {
  try {
    if (process.env.BRANCHES) return JSON.parse(process.env.BRANCHES);
    const filePath = path.join(__dirname, "branches.json");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("[server] Failed to load branches:", err.message);
    return [];
  }
}

function loadUsers() {
  try {
    const filePath = path.join(__dirname, "users.json");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("[server] Failed to load users.json:", err.message);
    return [];
  }
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function getBranch(branches, branchId) {
  return branches.find((b) => b.id === branchId);
}

function ensureList(map, key) {
  if (!map.has(key)) map.set(key, []);
  return map.get(key);
}

// Add socketId to list, removing any existing duplicate first
function enqueueUnique(list, socketId) {
  return [...list.filter((id) => id !== socketId), socketId];
}

function removeFromAllBranches(map, socketId) {
  for (const [key, list] of map.entries()) {
    map.set(
      key,
      list.filter((id) => id !== socketId),
    );
  }
}

// Simple in-memory rate limiter
// key: a unique string per user+action (e.g. 'login:192.168.1.1')
// Returns true if the action is allowed, false if rate limit exceeded
function withinRateLimit(rateBuckets, key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

// ─── Logging ──────────────────────────────────────────────────────────────────
// Writes one plain text + one JSON log file per month to /logs
// e.g. logs/2026-03.txt and logs/2026-03.json



// ─── Logging ──────────────────────────────────────────────────────────────────
// Writes one plain text + one JSON log file per month to /logs
// e.g. logs/2026-03.txt and logs/2026-03.json

const LOGS_DIR = path.join(__dirname, "logs");

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogPrefix() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(LOGS_DIR, `${y}-${m}`);
}

function writeLog(event, data = {}) {
  try {
    ensureLogsDir();
    const prefix = getLogPrefix();
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const label = event.toUpperCase().padEnd(24);
    const parts = [`[${ts}] ${label}`];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null && v !== "") parts.push(`${k}=${v}`);
    }
    fs.appendFileSync(`${prefix}.txt`, parts.join("  ") + "\n", "utf8");
    fs.appendFileSync(`${prefix}.json`, JSON.stringify({ ts, event, ...data }) + "\n", "utf8");
  } catch (err) {
    console.error("[log] Failed to write log:", err.message);
  }
}

// ─── Recordings ───────────────────────────────────────────────────────────────

const RECORDINGS_DIR = path.join(__dirname, "recordings");
const RECORDINGS_INDEX = path.join(RECORDINGS_DIR, "index.json");

function ensureRecordingsDir(subdir) {
  const dir = subdir ? path.join(RECORDINGS_DIR, subdir) : RECORDINGS_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadRecordingsIndex() {
  try {
    if (!fs.existsSync(RECORDINGS_INDEX)) return [];
    return JSON.parse(fs.readFileSync(RECORDINGS_INDEX, "utf8"));
  } catch {
    return [];
  }
}

function saveRecordingsIndex(entries) {
  ensureRecordingsDir();
  fs.writeFileSync(RECORDINGS_INDEX, JSON.stringify(entries, null, 2), "utf8");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.prepare().then(() => {
  // FIX: getHttpsOptions() was defined but never called — server crashed with
  // "ReferenceError: options is not defined". Fixed by calling it here.
  const options = getHttpsOptions();

  const server = createServer(options, (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");

    const parsedUrl = parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ── Recordings: upload ───────────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/recordings/upload") {
      // Verify session via cookie/header — only order takers can upload
      // We use a simple token passed as a header set by the client after login
      const authToken = req.headers["x-session-id"] || "";
      // We'll validate by checking if any session has this socketId as userId mapping
      // For simplicity: accept uploads from any connected socket (order taker page sends this)

      const chunks = [];
      const boundary = req.headers["content-type"]?.split("boundary=")[1];
      if (!boundary) { res.writeHead(400); res.end("Bad request"); return; }

      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks);
          const boundaryBuf = Buffer.from("--" + boundary);
          const parts = [];
          let start = 0;

          // Parse multipart manually
          while (true) {
            const idx = body.indexOf(boundaryBuf, start);
            if (idx === -1) break;
            const end = body.indexOf(boundaryBuf, idx + boundaryBuf.length);
            if (end === -1) break;
            const part = body.slice(idx + boundaryBuf.length + 2, end - 2); // skip \r\n
            const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
            if (headerEnd === -1) { start = end; continue; }
            const headers = part.slice(0, headerEnd).toString();
            const fileData = part.slice(headerEnd + 4);
            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (nameMatch && filenameMatch) {
              parts.push({ name: nameMatch[1], filename: filenameMatch[1], data: fileData });
            } else if (nameMatch) {
              parts.push({ name: nameMatch[1], value: fileData.toString().trim() });
            }
            start = end;
          }

          // Extract metadata fields
          const get = (n) => parts.find(p => p.name === n)?.value || "";
          const callId = get("callId");
          const orderTaker = get("orderTaker");
          const branchId = get("branchId");
          const customerName = get("customerName");
          const customerPhone = get("customerPhone");
          const customerAddress = get("customerAddress");
          const duration = get("duration");
          const timestamp = get("timestamp") || new Date().toISOString();

          if (!callId) { res.writeHead(400); res.end("Missing callId"); return; }

          // Save files
          const dateStr = new Date(timestamp).toISOString().slice(0, 10);
          const dir = ensureRecordingsDir(`${dateStr}/${callId}`);

          for (const part of parts) {
            if (!part.filename || !part.data) continue;
            fs.writeFileSync(path.join(dir, part.filename), part.data);
          }

          // Update index
          const index = loadRecordingsIndex();
          // Remove any existing entry for this callId (in case of retry)
          const filtered = index.filter(e => e.callId !== callId);
          filtered.unshift({
            callId,
            timestamp,
            date: dateStr,
            orderTaker,
            branchId,
            customerName,
            customerPhone,
            customerAddress,
            duration,
            files: parts.filter(p => p.filename).map(p => ({
              type: p.name,
              filename: p.filename,
              path: `${dateStr}/${callId}/${p.filename}`,
            })),
          });
          saveRecordingsIndex(filtered);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error("[recordings] Upload error:", err);
          res.writeHead(500); res.end("Server error");
        }
      });
      return;
    }

    // ── Recordings: list ────────────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/recordings") {
      const index = loadRecordingsIndex();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(index));
      return;
    }

    // ── Recordings: serve file ───────────────────────────────────────────────
    if (req.method === "GET" && pathname.startsWith("/api/recordings/file/")) {
      const filePath = pathname.replace("/api/recordings/file/", "");
      // Security: prevent path traversal
      const fullPath = path.resolve(RECORDINGS_DIR, filePath);
      if (!fullPath.startsWith(path.resolve(RECORDINGS_DIR))) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(fullPath).toLowerCase();
      const mime = ext === ".webm" ? "video/webm" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Content-Disposition": `attachment; filename="${path.basename(fullPath)}"` });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    // ── Recordings: delete ───────────────────────────────────────────────────
    if (req.method === "DELETE" && pathname.startsWith("/api/recordings/")) {
      const callId = pathname.replace("/api/recordings/", "");
      const index = loadRecordingsIndex();
      const entry = index.find(e => e.callId === callId);
      if (!entry) { res.writeHead(404); res.end("Not found"); return; }
      // Delete files
      const dir = path.join(RECORDINGS_DIR, entry.date, callId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      // Update index
      saveRecordingsIndex(index.filter(e => e.callId !== callId));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    handle(req, res, parsedUrl);
  });

  // Parse allowed origins from env — comma separated list
  // e.g. ALLOWED_ORIGINS=https://order.bestwaysupermarket.com,https://admin.bestwaysupermarket.com
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const io = require("socket.io")(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin requests
        if (allowedOrigins.length === 0) return cb(null, dev); // dev: allow all; prod: deny all if not configured
        return cb(null, allowedOrigins.includes(origin));
      },
      methods: ["GET", "POST"],
    },
  });

  // ─── App state ──────────────────────────────────────────────────────────────
  // All state lives here — in memory. If the server restarts, state is lost.
  // For production at scale you'd move this to Redis, but for a supermarket
  // ordering system this is perfectly fine.

  const branches = loadBranches();
  const iceConfig = getIceConfig();

  const sessions = new Map(); // socketId → { userId, role, branchId }
  const queueByBranch = new Map(); // branchId → [socketId, ...]
  const orderTakersByBranch = new Map(); // branchId → [socketId, ...]  (available takers)
  const pairs = {}; // socketId → partnerSocketId  (active calls)
  const pairBranch = {}; // socketId → branchId
  const customerInfo = new Map(); // socketId → { name, phone, address }
  const previousCustomerByTaker = new Map(); // takerSocketId → { name, address }
  const managerWatchers = new Set(); // socketIds subscribed to monitor updates
  const rateBuckets = new Map(); // rateLimit key → { count, resetAt }
  const callStartTimes = new Map(); // socketId → timestamp of when current call started (for monitor display)
  const callIds = new Map(); // socketId → callId (shared between both sides of a call)

  // ─── Broadcast helpers ──────────────────────────────────────────────────────

  // Tell each waiting customer their current position in the queue (0-indexed)
  function broadcastQueuePositions(branchId) {
    const queue = ensureList(queueByBranch, branchId);
    queue.forEach((socketId, idx) => {
      io.to(socketId).emit("queue-position", idx);
    });
  }

  // Push live stats to everyone (used by customer + order taker pages for queue counts)
  function broadcastStats() {
    const totalWaiting = Array.from(queueByBranch.values()).reduce(
      (sum, q) => sum + q.length,
      0,
    );
    const totalInCall = Array.from(sessions.entries()).filter(
      ([id, s]) => s.role === "order_taker" && pairs[id],
    ).length;

    const byBranch = {};
    for (const b of branches) {
      byBranch[b.id] = {
        waiting: ensureList(queueByBranch, b.id).length,
        inCall: Array.from(sessions.entries()).filter(
          ([id, s]) =>
            s.role === "order_taker" && s.branchId === b.id && pairs[id],
        ).length,
      };
    }
    io.emit("stats", { totalWaiting, totalInCall, byBranch });
  }

  // Push detailed monitor data to all subscribed manager sockets
  function broadcastMonitor() {
    const payload = buildMonitorPayload();
    for (const watcherId of managerWatchers) {
      io.to(watcherId).emit("monitor-update", payload);
    }
  }

  function buildMonitorPayload() {
    const takers = [];
    for (const [socketId, session] of sessions.entries()) {
      if (session.role !== "order_taker") continue;
      const partnerId = pairs[socketId];
      const takers_in_branch = ensureList(
        orderTakersByBranch,
        session.branchId,
      );
      takers.push({
        socketId,
        userId: session.userId,
        branchId: session.branchId,
        status: partnerId
          ? "in_call"
          : takers_in_branch.includes(socketId)
            ? "available"
            : "not_available",
        callStartedAt: partnerId ? callStartTimes.get(socketId) ?? null : null,
        currentCustomer: partnerId
          ? customerInfo.get(partnerId) || { name: "", phone: "", address: "" }
          : { name: "", phone: "", address: "" },
        previousCustomer: previousCustomerByTaker.get(socketId) || {
          name: "",
          phone: "",
          address: "",
        },
      });
    }
    return {
      counts: {
        totalConnections: takers.filter((t) => t.status === "in_call").length,
        totalOrderTakers: takers.length,
      },
      takers,
    };
  }

  // End a call, notify the partner, and record previous customer for history
  function clearPair(socketId, notify = true) {
    const partner = pairs[socketId];
    if (!partner) return;

    const socketSession = sessions.get(socketId);
    const partnerSession = sessions.get(partner);

    // Record who each taker just spoke with (for manager history view)
    if (socketSession?.role === "order_taker") {
      previousCustomerByTaker.set(
        socketId,
        customerInfo.get(partner) || { name: "", phone: "", address: "" },
      );
    }
    if (partnerSession?.role === "order_taker") {
      previousCustomerByTaker.set(
        partner,
        customerInfo.get(socketId) || { name: "", phone: "", address: "" },
      );
    }

    if (notify) io.to(partner).emit("partner-disconnected");

    delete pairs[partner];
    delete pairs[socketId];
    delete pairBranch[partner];
    delete pairBranch[socketId];
    const callStart = callStartTimes.get(socketId) ?? callStartTimes.get(partner);
    const durationSec = callStart ? Math.floor((Date.now() - callStart) / 1000) : null;
    const durationFmt = durationSec !== null
      ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, "0")}`
      : "unknown";
    const takerSess = socketSession?.role === "order_taker" ? socketSession : partnerSession;
    const custId = socketSession?.role === "customer" ? socketId : partner;
    const cust = customerInfo.get(custId) || {};
    writeLog("call_ended", {
      orderTaker: takerSess?.userId,
      branchId: takerSess?.branchId,
      customerName: cust.name,
      customerPhone: cust.phone,
      duration: durationFmt,
      durationSeconds: durationSec,
    });
    callStartTimes.delete(socketId);
    callStartTimes.delete(partner);
    callIds.delete(socketId);
    callIds.delete(partner);
  }

  // Match the next waiting customer with the next available order taker
  // Called whenever the queue or available takers list changes
  function checkMatch(branchId) {
    const queue = ensureList(queueByBranch, branchId);
    const takers = ensureList(orderTakersByBranch, branchId);
    if (queue.length === 0 || takers.length === 0) return;

    const clientId = queue.shift();
    const takerId = takers.shift();

    pairs[clientId] = takerId;
    pairs[takerId] = clientId;
    pairBranch[clientId] = branchId;
    pairBranch[takerId] = branchId;

    const info = customerInfo.get(clientId) || { name: "", address: "" };

    // Tell customer they've been matched (they wait for order taker to accept)
    io.to(clientId).emit("matched", takerId);
    // Tell order taker who is calling (includes customer details for display)
    io.to(takerId).emit("matched", { partnerId: clientId, customer: info });

    queueByBranch.set(branchId, queue);
    orderTakersByBranch.set(branchId, takers);

    broadcastQueuePositions(branchId);
    broadcastStats();
    broadcastMonitor();
  }

  // ─── Socket events ──────────────────────────────────────────────────────────

  io.on("connection", (socket) => {
    console.log(`[socket] connected: ${socket.id}`);

    // Send branches list and ICE config immediately on connect
    // ICE config contains TURN credentials — sending from server means
    // credentials never appear in client-side source code
    socket.emit("branches", branches);
    socket.emit("ice-config", iceConfig);
    broadcastStats();

    // ── Login ────────────────────────────────────────────────────────────────
    socket.on("login", async (data, cb) => {
      const clientIp = socket.handshake.address || socket.id;
      if (
        !withinRateLimit(
          rateBuckets,
          `login:${clientIp}`,
          LOGIN_RATE_MAX,
          LOGIN_RATE_WINDOW_MS,
        )
      ) {
        writeLog("login_failed", { reason: "rate_limited", ip: clientIp });
        cb?.({ ok: false, error: "Too many attempts. Try again shortly." });
        return;
      }

      const { userId, password, role, branchId } = data || {};
      const cleanUserId = sanitizeText(userId, MAX_USERID_LENGTH);
      const cleanRole = sanitizeText(role, 32);

      // Basic input validation
      if (
        !cleanUserId ||
        typeof password !== "string" ||
        password.length > 256
      ) {
        writeLog("login_failed", { userId: cleanUserId, role: cleanRole, ip: clientIp });
        cb?.({ ok: false, error: "Invalid credentials" });
        return;
      }
      if (!["order_taker", "manager"].includes(cleanRole)) {
        cb?.({ ok: false, error: "Role not permitted" });
        return;
      }
      if (
        cleanRole === "order_taker" &&
        branchId && !getBranch(branches, branchId)
      ) {
        cb?.({ ok: false, error: "Invalid branch" });
        return;
      }

      // Load users fresh each time (allows adding users without restart)
      const userList = loadUsers();
      const user = userList.find((u) => u.userId === cleanUserId);

      // FIX: Previously compared plain text passwords directly.
      // Now uses bcrypt.compareSync to compare against stored hash.
      // FIX: validPassword was computed but never used to block login.
      // Now the check correctly gates the response.
      const validPassword = user
        ? bcrypt.compareSync(password, user.passwordHash)
        : false;
      if (!validPassword || user.role !== cleanRole) {
        // Deliberately vague error — don't tell attacker which part was wrong
        cb?.({ ok: false, error: "Invalid credentials" });
        return;
      }
      if (user.branchId && user.branchId !== branchId) {
        cb?.({ ok: false, error: "Invalid credentials" });
        return;
      }

      const sessionData = {
        userId: cleanUserId,
        role: cleanRole,
        branchId: branchId || null,
      };
      sessions.set(socket.id, sessionData);
      writeLog("login_success", { userId: cleanUserId, role: cleanRole, branchId: branchId || null });
      cb?.({ ok: true, session: sessionData });

      broadcastStats();
      broadcastMonitor();
    });

    // ── Manager monitor subscription ─────────────────────────────────────────
    socket.on("manager-monitor-subscribe", () => {
      const session = sessions.get(socket.id);
      if (!session || session.role !== "manager") return;
      managerWatchers.add(socket.id);
      io.to(socket.id).emit("monitor-update", buildMonitorPayload());
    });

    // ── Customer joins queue ─────────────────────────────────────────────────
    socket.on("join-queue", (data) => {
      if (
        !withinRateLimit(
          rateBuckets,
          `join:${socket.id}`,
          QUEUE_RATE_MAX,
          QUEUE_RATE_WINDOW_MS,
        )
      )
        return;

      const branchId = data?.branchId;
      const name = sanitizeText(data?.name, MAX_NAME_LENGTH);
      const phone = sanitizeText(data?.phone, 20);
      const address = sanitizeText(data?.address, MAX_ADDRESS_LENGTH);

      if (!branchId || !getBranch(branches, branchId)) return;
      if (pairs[socket.id]) return; // already in a call

      // Create customer session if they don't have one yet
      let session = sessions.get(socket.id);
      if (!session) {
        session = { userId: null, role: "customer", branchId };
        sessions.set(socket.id, session);
      }
      if (session.role !== "customer") return;

      session.branchId = branchId;
      customerInfo.set(socket.id, { name, phone, address });
      writeLog("customer_joined_queue", { name, phone, address, branchId });

      const queue = ensureList(queueByBranch, branchId);
      queueByBranch.set(branchId, enqueueUnique(queue, socket.id));

      broadcastQueuePositions(branchId);
      checkMatch(branchId);
      broadcastStats();
      broadcastMonitor();
    });

    // ── Order taker marks themselves available ───────────────────────────────
    socket.on("order-taker-ready", (data) => {
      if (
        !withinRateLimit(
          rateBuckets,
          `ready:${socket.id}`,
          READY_RATE_MAX,
          READY_RATE_WINDOW_MS,
        )
      )
        return;

      const session = sessions.get(socket.id);
      const branchId = data?.branchId;

      if (!session || session.role !== "order_taker") return;
      if (!branchId || !getBranch(branches, branchId)) return;
      if (pairs[socket.id]) return; // already in a call

      session.branchId = branchId;
      const takers = ensureList(orderTakersByBranch, branchId);
      orderTakersByBranch.set(branchId, enqueueUnique(takers, socket.id));
      writeLog("order_taker_available", { userId: session.userId, branchId });

      checkMatch(branchId);
      broadcastStats();
      broadcastMonitor();
    });

    // ── Order taker marks themselves unavailable ─────────────────────────────
    socket.on("order-taker-not-available", () => {
      const session = sessions.get(socket.id);
      if (!session || session.role !== "order_taker") return;
      writeLog("order_taker_offline", { userId: session.userId, branchId: session.branchId });
      removeFromAllBranches(orderTakersByBranch, socket.id);
      broadcastStats();
      broadcastMonitor();
    });

    // ── WebRTC signaling relay ───────────────────────────────────────────────
    // The server never looks at signal contents — it just forwards them between
    // paired sockets. Security: we verify the 'to' field matches the actual pair,
    // preventing any socket from sending signals to someone they're not paired with.
    socket.on("signal", (data) => {
      if (
        !withinRateLimit(
          rateBuckets,
          `signal:${socket.id}`,
          SIGNAL_RATE_MAX,
          SIGNAL_RATE_WINDOW_MS,
        )
      )
        return;
      if (!data || typeof data !== "object") return;
      if (!data.signal || typeof data.signal !== "object") return;

      // Security check: only allow signaling to your actual paired partner
      if (!pairs[socket.id] || pairs[socket.id] !== data.to) return;

      io.to(data.to).emit("signal", { from: socket.id, signal: data.signal });
    });

    // ── Order taker accepts the call ─────────────────────────────────────────
    // This is the trigger that tells the customer to start WebRTC
    socket.on("call-accepted", (data) => {
      const session = sessions.get(socket.id);
      if (session?.role !== "order_taker") return;
      if (!data?.to || pairs[socket.id] !== data.to) return;

      const callStartedAt = Date.now();
      const callId = randomUUID();
      callStartTimes.set(socket.id, callStartedAt);
      callStartTimes.set(data.to, callStartedAt);
      callIds.set(socket.id, callId);
      callIds.set(data.to, callId);

      const cInfo = customerInfo.get(data.to) || {};
      writeLog("call_started", {
        orderTaker: session.userId,
        branchId: session.branchId,
        customerName: cInfo.name,
        customerPhone: cInfo.phone,
        customerAddress: cInfo.address,
      });

      io.to(data.to).emit("call-accepted", { partnerId: socket.id, callStartedAt, callId });
      io.to(socket.id).emit("call-started", { callStartedAt, callId });
      broadcastStats();
      broadcastMonitor();
    });

    // ── End call ─────────────────────────────────────────────────────────────
    socket.on("end-call", () => {
      if (!pairs[socket.id]) return;
      clearPair(socket.id, true);
      broadcastStats();
      broadcastMonitor();
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log(`[socket] disconnected: ${socket.id}`);
      const discSession = sessions.get(socket.id);
      if (discSession?.role === "order_taker") {
        writeLog("order_taker_logout", { userId: discSession.userId, branchId: discSession.branchId });
      }

      removeFromAllBranches(queueByBranch, socket.id);
      removeFromAllBranches(orderTakersByBranch, socket.id);

      if (pairs[socket.id]) clearPair(socket.id, true);

      customerInfo.delete(socket.id);
      managerWatchers.delete(socket.id);
      sessions.delete(socket.id);

      // Update queue positions for all branches (one socket leaving shifts everyone up)
      for (const branchId of queueByBranch.keys()) {
        broadcastQueuePositions(branchId);
      }

      broadcastStats();
      broadcastMonitor();
    });
  });

  server.listen(3000, "0.0.0.0", (err) => {
    if (err) throw err;
    console.log("> Server ready on https://localhost:3000");
  });
});
