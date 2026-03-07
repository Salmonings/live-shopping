const { createServer } = require('https')
const { parse } = require('url')
const next = require('next')
const selfsigned = require('selfsigned')
const fs = require('fs')
const path = require('path')

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

// Generate self-signed certificate
const attrs = [{ name: 'commonName', value: 'localhost' }]
const pems = selfsigned.generate(attrs, { days: 365, keySize: 4096 })
const options = {
  key: pems.private,
  cert: pems.cert
}

app.prepare().then(() => {
  const server = createServer(options, (req, res) => {
    // Basic security headers.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

  const io = require('socket.io')(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true)
        if (allowedOrigins.length === 0) {
          return cb(null, dev)
        }
        return cb(null, allowedOrigins.includes(origin))
      },
      methods: ['GET', 'POST']
    }
  })

  const branches = loadBranches()
  const usersFile = path.join(__dirname, 'users.json')

  const sessions = new Map() // socketId -> { userId, role, branchId }
  const queueByBranch = new Map() // branchId -> [socketId]
  const orderTakersByBranch = new Map() // branchId -> [socketId]
  const pairs = {} // socketId -> partnerSocketId
  const pairBranch = {} // socketId -> branchId
  const customerInfo = new Map() // socketId -> { name, address }
  const previousCustomerByTaker = new Map() // takerSocketId -> { name, address }
  const managerWatchers = new Set() // socketIds
  const rateBuckets = new Map() // key -> { count, resetAt }

  const MAX_NAME_LENGTH = 80
  const MAX_ADDRESS_LENGTH = 180
  const LOGIN_RATE_MAX = 10
  const LOGIN_RATE_WINDOW_MS = 60 * 1000
  const QUEUE_RATE_MAX = 5
  const QUEUE_RATE_WINDOW_MS = 10 * 1000
  const READY_RATE_MAX = 10
  const READY_RATE_WINDOW_MS = 10 * 1000
  const SIGNAL_RATE_MAX = 120
  const SIGNAL_RATE_WINDOW_MS = 10 * 1000

  function loadBranches() {
    try {
      if (process.env.BRANCHES) {
        return JSON.parse(process.env.BRANCHES)
      }
      const filePath = path.join(__dirname, 'branches.json')
      const raw = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      console.error('Failed to load branches:', err)
      return []
    }
  }

  function loadUsers() {
    try {
      const raw = fs.readFileSync(usersFile, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      console.error('Failed to load users.json:', err)
      return []
    }
  }

  function clientKey(socket) {
    return socket.handshake.address || socket.id
  }

  function withinRateLimit(key, max, windowMs) {
    const now = Date.now()
    const bucket = rateBuckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    if (bucket.count >= max) return false
    bucket.count += 1
    return true
  }

  function sanitizeText(value, maxLen) {
    if (typeof value !== 'string') return ''
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLen)
  }

  function getBranch(branchId) {
    return branches.find(b => b.id === branchId)
  }

  function ensureList(map, branchId) {
    if (!map.has(branchId)) map.set(branchId, [])
    return map.get(branchId)
  }

  function enqueueUnique(list, socketId) {
    const next = list.filter(id => id !== socketId)
    next.push(socketId)
    return next
  }

  function removeFromAllBranches(map, socketId) {
    for (const [branchId, list] of map.entries()) {
      const next = list.filter(id => id !== socketId)
      map.set(branchId, next)
    }
  }

  function broadcastQueuePositions(branchId) {
    const queue = ensureList(queueByBranch, branchId)
    queue.forEach((socketId, idx) => {
      io.to(socketId).emit('queue-position', idx)
    })
  }

  function broadcastStats() {
    const totalWaiting = Array.from(queueByBranch.values()).reduce((sum, q) => sum + q.length, 0)
    const totalInCall = Array.from(sessions.entries()).filter(([socketId, s]) => s.role === 'order_taker' && pairs[socketId]).length
    const byBranch = {}
    for (const b of branches) {
      const waiting = ensureList(queueByBranch, b.id).length
      const inCall = Array.from(sessions.entries()).filter(([socketId, s]) => s.role === 'order_taker' && s.branchId === b.id && pairs[socketId]).length
      byBranch[b.id] = { waiting, inCall }
    }
    io.emit('stats', { totalWaiting, totalInCall, byBranch })
  }

  function isTakerAvailable(socketId, branchId) {
    if (!branchId) return false
    const takers = ensureList(orderTakersByBranch, branchId)
    return takers.includes(socketId)
  }

  function activeCallCount() {
    let count = 0
    for (const [socketId, session] of sessions.entries()) {
      if (session.role === 'order_taker' && pairs[socketId]) count += 1
    }
    return count
  }

  function buildMonitorPayload() {
    const takers = []
    for (const [socketId, session] of sessions.entries()) {
      if (session.role !== 'order_taker') continue
      const partnerId = pairs[socketId]
      const inCall = Boolean(partnerId)
      const currentCustomer = partnerId ? (customerInfo.get(partnerId) || { name: '', address: '' }) : { name: '', address: '' }
      const previousCustomer = previousCustomerByTaker.get(socketId) || { name: '', address: '' }
      takers.push({
        socketId,
        userId: session.userId,
        branchId: session.branchId,
        status: inCall ? 'in_call' : (isTakerAvailable(socketId, session.branchId) ? 'available' : 'not_available'),
        currentCustomer,
        previousCustomer
      })
    }
    return {
      counts: {
        totalConnections: activeCallCount(),
        totalOrderTakers: takers.length
      },
      takers
    }
  }

  function broadcastMonitor() {
    const payload = buildMonitorPayload()
    for (const watcherId of managerWatchers) {
      io.to(watcherId).emit('monitor-update', payload)
    }
  }

  function clearPair(socketId, notify = true) {
    const partner = pairs[socketId]
    if (!partner) return
    const socketSession = sessions.get(socketId)
    const partnerSession = sessions.get(partner)
    const socketIsTaker = socketSession?.role === 'order_taker'
    const partnerIsTaker = partnerSession?.role === 'order_taker'
    if (socketIsTaker) {
      previousCustomerByTaker.set(socketId, customerInfo.get(partner) || { name: '', address: '' })
    }
    if (partnerIsTaker) {
      previousCustomerByTaker.set(partner, customerInfo.get(socketId) || { name: '', address: '' })
    }
    if (notify) {
      io.to(partner).emit('partner-disconnected')
    }
    delete pairs[partner]
    delete pairs[socketId]
    delete pairBranch[partner]
    delete pairBranch[socketId]
  }

  io.on('connection', (socket) => {
    console.log('a user connected:', socket.id)

    socket.emit('branches', branches)
    broadcastStats()

    socket.on('login', (data, cb) => {
      if (!withinRateLimit(`login:${clientKey(socket)}`, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS)) {
        cb?.({ ok: false, error: 'Too many attempts. Try again shortly.' })
        return
      }
      const { userId, password, role, branchId } = data || {}
      const cleanUserId = sanitizeText(userId, 64)
      const cleanRole = sanitizeText(role, 32)
      if (!cleanUserId || typeof password !== 'string' || password.length > 256) {
        cb?.({ ok: false, error: 'Invalid credentials' })
        return
      }
      if (!['order_taker', 'manager'].includes(cleanRole)) {
        cb?.({ ok: false, error: 'Role not permitted' })
        return
      }
      const userList = loadUsers()
      const user = userList.find(u => u.userId === cleanUserId && u.password === password)
      if (!user) {
        cb?.({ ok: false, error: 'Invalid credentials' })
        return
      }
      if (user.role !== cleanRole) {
        cb?.({ ok: false, error: 'Role not permitted' })
        return
      }
      if (cleanRole === 'order_taker') {
        if (!branchId || !getBranch(branchId)) {
          cb?.({ ok: false, error: 'Invalid branch' })
          return
        }
      }
      sessions.set(socket.id, { userId: cleanUserId, role: cleanRole, branchId: branchId || null })
      cb?.({ ok: true, session: { userId: cleanUserId, role: cleanRole, branchId: branchId || null } })
      broadcastStats()
      broadcastMonitor()
    })

    socket.on('manager-monitor-subscribe', () => {
      const session = sessions.get(socket.id)
      if (!session || session.role !== 'manager') return
      managerWatchers.add(socket.id)
      io.to(socket.id).emit('monitor-update', buildMonitorPayload())
    })

    socket.on('join-queue', (data) => {
      if (!withinRateLimit(`join:${socket.id}`, QUEUE_RATE_MAX, QUEUE_RATE_WINDOW_MS)) return
      let session = sessions.get(socket.id)
      const branchId = data?.branchId
      const name = sanitizeText(data?.name, MAX_NAME_LENGTH)
      const address = sanitizeText(data?.address, MAX_ADDRESS_LENGTH)
      if (!branchId || !getBranch(branchId)) return
      if (!session) {
        session = { userId: null, role: 'customer', branchId }
        sessions.set(socket.id, session)
      }
      if (session.role !== 'customer') return
      if (!branchId || !getBranch(branchId)) return
      if (pairs[socket.id]) return
      session.branchId = branchId
      customerInfo.set(socket.id, { name, address })
      const queue = ensureList(queueByBranch, branchId)
      queueByBranch.set(branchId, enqueueUnique(queue, socket.id))
      broadcastQueuePositions(branchId)
      checkMatch(branchId)
      broadcastStats()
      broadcastMonitor()
    })

    socket.on('order-taker-ready', (data) => {
      if (!withinRateLimit(`ready:${socket.id}`, READY_RATE_MAX, READY_RATE_WINDOW_MS)) return
      const session = sessions.get(socket.id)
      const branchId = data?.branchId
      if (!session || session.role !== 'order_taker') return
      if (!branchId || !getBranch(branchId)) return
      if (pairs[socket.id]) return
      session.branchId = branchId
      const takers = ensureList(orderTakersByBranch, branchId)
      orderTakersByBranch.set(branchId, enqueueUnique(takers, socket.id))
      checkMatch(branchId)
      broadcastStats()
      broadcastMonitor()
    })

    socket.on('order-taker-not-available', () => {
      const session = sessions.get(socket.id)
      if (!session || session.role !== 'order_taker') return
      removeFromAllBranches(orderTakersByBranch, socket.id)
      broadcastStats()
      broadcastMonitor()
    })

    socket.on('signal', (data) => {
      if (!withinRateLimit(`signal:${socket.id}`, SIGNAL_RATE_MAX, SIGNAL_RATE_WINDOW_MS)) return
      if (!data || typeof data !== 'object') return
      if (!pairs[socket.id] || pairs[socket.id] !== data.to) return
      if (!data.signal || typeof data.signal !== 'object') return
      io.to(data.to).emit('signal', { from: socket.id, signal: data.signal })
    })

    socket.on('call-accepted', (data) => {
      const session = sessions.get(socket.id)
      if (session?.role !== 'order_taker') return
      if (data?.to && pairs[socket.id] === data.to) {
        io.to(data.to).emit('call-accepted', socket.id)
      }
      broadcastStats()
      broadcastMonitor()
    })

    // Peer signals they want to end the call (user pressed End Call)
    socket.on('end-call', () => {
      if (pairs[socket.id]) {
        clearPair(socket.id, true)
        broadcastStats()
        broadcastMonitor()
      }
    })

    socket.on('disconnect', () => {
      removeFromAllBranches(queueByBranch, socket.id)
      removeFromAllBranches(orderTakersByBranch, socket.id)
      if (pairs[socket.id]) clearPair(socket.id, true)
      customerInfo.delete(socket.id)
      managerWatchers.delete(socket.id)
      sessions.delete(socket.id)
      for (const branchId of queueByBranch.keys()) {
        broadcastQueuePositions(branchId)
      }
      broadcastStats()
      broadcastMonitor()
    })

    function checkMatch(branchId) {
      const queue = ensureList(queueByBranch, branchId)
      const takers = ensureList(orderTakersByBranch, branchId)
      if (queue.length > 0 && takers.length > 0) {
        const clientId = queue.shift()
        const takerId = takers.shift()
        // record the active pair both ways
        pairs[clientId] = takerId
        pairs[takerId] = clientId
        pairBranch[clientId] = branchId
        pairBranch[takerId] = branchId
        const info = customerInfo.get(clientId) || { name: '', address: '' }
        io.to(clientId).emit('matched', takerId)
        io.to(takerId).emit('matched', { partnerId: clientId, customer: info })
        queueByBranch.set(branchId, queue)
        orderTakersByBranch.set(branchId, takers)
        broadcastQueuePositions(branchId)
        broadcastStats()
        broadcastMonitor()
      }
    }
  })

  server.listen(3000, '0.0.0.0', (err) => {
    if (err) throw err
    console.log('> Ready on http://localhost:3000')
    console.log('> Also accessible on http://[your-ip]:3000 from other devices')
  })
})
