process.env.TURBOPACK = "0";
const { createServer } = require("https");
const { parse } = require("url");
const next = require("next");
const selfsigned = require("selfsigned");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

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
  const customerInfo = new Map(); // socketId → { name, address }
  const previousCustomerByTaker = new Map(); // takerSocketId → { name, address }
  const managerWatchers = new Set(); // socketIds subscribed to monitor updates
  const rateBuckets = new Map(); // rateLimit key → { count, resetAt }

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
        currentCustomer: partnerId
          ? customerInfo.get(partnerId) || { name: "", address: "" }
          : { name: "", address: "" },
        previousCustomer: previousCustomerByTaker.get(socketId) || {
          name: "",
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
        customerInfo.get(partner) || { name: "", address: "" },
      );
    }
    if (partnerSession?.role === "order_taker") {
      previousCustomerByTaker.set(
        partner,
        customerInfo.get(socketId) || { name: "", address: "" },
      );
    }

    if (notify) io.to(partner).emit("partner-disconnected");

    delete pairs[partner];
    delete pairs[socketId];
    delete pairBranch[partner];
    delete pairBranch[socketId];
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
        cb?.({ ok: false, error: "Invalid credentials" });
        return;
      }
      if (!["order_taker", "manager"].includes(cleanRole)) {
        cb?.({ ok: false, error: "Role not permitted" });
        return;
      }
      if (
        cleanRole === "order_taker" &&
        (!branchId || !getBranch(branches, branchId))
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

      const sessionData = {
        userId: cleanUserId,
        role: cleanRole,
        branchId: branchId || null,
      };
      sessions.set(socket.id, sessionData);
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
      customerInfo.set(socket.id, { name, address });

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

      checkMatch(branchId);
      broadcastStats();
      broadcastMonitor();
    });

    // ── Order taker marks themselves unavailable ─────────────────────────────
    socket.on("order-taker-not-available", () => {
      const session = sessions.get(socket.id);
      if (!session || session.role !== "order_taker") return;
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

      io.to(data.to).emit("call-accepted", socket.id);
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
