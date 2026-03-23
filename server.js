const express = require('express')
const http    = require('http')
const { Server } = require('socket.io')
const cors    = require('cors')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())
app.set('trust proxy', 1)

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' }
}))

const ALLOWED_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://localhost:8081',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://randomchat-server-production.up.railway.app',
  'https://voidcall-web.vercel.app',
]

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true)
      else { console.warn(`Blocked origin: ${origin}`); cb(new Error('Not allowed by CORS')) }
    },
    methods: ['GET', 'POST']
  },
  // Tuned for low-latency
  pingInterval:    10000,   // detect dead connections faster (was 25000)
  pingTimeout:      5000,   // (was 20000)
  upgradeTimeout:   5000,
  perMessageDeflate: false, // no compression overhead
  transports: ['websocket', 'polling'],
})

// ── State ──────────────────────────────────────────────────
// Indexed queues by gender — O(1) match instead of O(n) scan
const waitingQueues = { male: [], female: [], other: [] }
const waitingSet    = new Set()   // dedup — no socket added twice

const activeRooms       = new Map()
const userSessions      = new Map()
const socketEventCounts = new Map()
const reportCounts      = new Map()
const bannedIPs         = new Set()

const generateRoomId = () =>
  `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// ── Rate limiter (per socket) ──────────────────────────────
const isSocketRateLimited = (socketId) => {
  const now = Date.now(), window = 10000, max = 30
  if (!socketEventCounts.has(socketId)) socketEventCounts.set(socketId, [])
  const events = socketEventCounts.get(socketId).filter(t => now - t < window)
  events.push(now)
  socketEventCounts.set(socketId, events)
  return events.length > max
}

// ── Waiting pool helpers ───────────────────────────────────
const addToWaiting = (entry) => {
  if (waitingSet.has(entry.socketId)) return  // already queued — no duplicates
  const q = waitingQueues[entry.gender] || waitingQueues.other
  q.push(entry)
  waitingSet.add(entry.socketId)
}

const removeFromWaiting = (socketId) => {
  if (!waitingSet.has(socketId)) return
  for (const q of Object.values(waitingQueues)) {
    const i = q.findIndex(u => u.socketId === socketId)
    if (i !== -1) { q.splice(i, 1); break }
  }
  waitingSet.delete(socketId)
}

// ── Core match logic — O(1) for common case ────────────────
const findMatch = (gender, pref) => {
  // Which gender buckets to search
  const buckets = pref === 'any'
    ? ['male', 'female', 'other']
    : [pref, 'other']   // include 'other' as fallback when filtering

  for (const bucket of buckets) {
    const q = waitingQueues[bucket]
    for (let i = 0; i < q.length; i++) {
      const u = q[i]
      // Remove stale (disconnected) entries inline
      if (!u.socket.connected) {
        q.splice(i, 1); waitingSet.delete(u.socketId); i--; continue
      }
      // Bidirectional compatibility check
      const theyWantMe = u.pref === 'any' || u.pref === gender
      if (theyWantMe) {
        q.splice(i, 1)
        waitingSet.delete(u.socketId)
        return u
      }
    }
  }
  return null
}

// ── Match two sockets into a room ──────────────────────────
const matchPair = (socketA, sessionA, partnerEntry) => {
  const roomId = generateRoomId()
  socketA.join(roomId)
  partnerEntry.socket.join(roomId)
  activeRooms.set(roomId, [socketA.id, partnerEntry.socketId])

  userSessions.set(socketA.id, {
    ...sessionA, room: roomId, partnerId: partnerEntry.socketId
  })
  userSessions.set(partnerEntry.socketId, {
    ...userSessions.get(partnerEntry.socketId),
    room: roomId, partnerId: socketA.id
  })

  socketA.emit('match_found', {
    roomId, initiator: true,
    partnerGender: partnerEntry.gender,
    partnerId: partnerEntry.socketId
  })
  partnerEntry.socket.emit('match_found', {
    roomId, initiator: false,
    partnerGender: sessionA.gender,
    partnerId: socketA.id
  })

  console.log(`🎯 Matched: ${socketA.id}(${sessionA.gender}) <-> ${partnerEntry.socketId}(${partnerEntry.gender})`)
}

// ── Clean stale entries every 15s ──────────────────────────
setInterval(() => {
  let cleaned = 0
  for (const q of Object.values(waitingQueues)) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (!q[i].socket.connected) {
        waitingSet.delete(q[i].socketId)
        q.splice(i, 1)
        cleaned++
      }
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale pool entries`)
}, 15000)

// ── Socket connections ────────────────────────────────────
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
                || socket.handshake.address

  if (bannedIPs.has(clientIP)) {
    console.log(`🚫 Banned IP tried to connect: ${clientIP}`)
    socket.disconnect(true)
    return
  }

  console.log(`✅ Connected: ${socket.id} (${clientIP})`)
  userSessions.set(socket.id, { room: null, partnerId: null, reportCount: 0, gender: 'other', pref: 'any', ip: clientIP })

  const checkRate = () => {
    if (isSocketRateLimited(socket.id)) {
      socket.emit('error', { message: 'Rate limited. Slow down.' })
      return false
    }
    return true
  }

  // ── 1. Find Match ────────────────────────────────────────
  socket.on('find_match', (data = {}) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    const { gender = 'other', pref = 'any' } = data

    const validGenders = ['male', 'female', 'other']
    const validPrefs   = ['any', 'male', 'female']
    const safeGender = validGenders.includes(gender) ? gender : 'other'
    const safePref   = validPrefs.includes(pref)     ? pref   : 'any'

    // Leave any existing room first
    if (session?.room) leaveRoom(socket)

    // Remove from waiting pool if already there (re-search scenario)
    removeFromWaiting(socket.id)

    const updatedSession = { ...session, gender: safeGender, pref: safePref }
    userSessions.set(socket.id, updatedSession)

    const partner = findMatch(safeGender, safePref)
    if (partner) {
      matchPair(socket, updatedSession, partner)
    } else {
      addToWaiting({ socketId: socket.id, socket, gender: safeGender, pref: safePref })
      socket.emit('waiting')
    }
  })

  // ── 2. WebRTC Signaling ──────────────────────────────────
  socket.on('offer', ({ roomId, offer }) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    if (session?.room !== roomId) return
    socket.to(roomId).emit('offer', offer)
  })

  socket.on('answer', ({ roomId, answer }) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    if (session?.room !== roomId) return
    socket.to(roomId).emit('answer', answer)
  })

  socket.on('ice_candidate', ({ roomId, candidate }) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    if (session?.room !== roomId) return
    socket.to(roomId).emit('ice_candidate', candidate)
  })

  // ── 3. Next ──────────────────────────────────────────────
  socket.on('next', () => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    leaveRoom(socket)
    removeFromWaiting(socket.id)

    const { gender = 'other', pref = 'any' } = session || {}
    const partner = findMatch(gender, pref)
    if (partner) {
      matchPair(socket, { ...session, gender, pref }, partner)
    } else {
      addToWaiting({ socketId: socket.id, socket, gender, pref })
      socket.emit('waiting')
    }
  })

  // ── 4. Chat ──────────────────────────────────────────────
  socket.on('chat_message', ({ roomId, message }) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    if (session?.room !== roomId) return
    const safeMsg = String(message || '').slice(0, 200)
    if (!safeMsg) return
    socket.to(roomId).emit('chat_message', { message: safeMsg })
  })

  // ── 5. Report ────────────────────────────────────────────
  socket.on('report_user', ({ reportedId, reason }) => {
    if (!checkRate()) return
    const safeReason = String(reason || '').slice(0, 200)

    if (!reportedId || !io.sockets.sockets.has(reportedId)) {
      console.log(`⚠️ Report ignored — invalid reportedId: ${reportedId}`)
      return
    }

    console.log(`🚨 Report: ${socket.id} reported ${reportedId} for: ${safeReason}`)
    const count = (reportCounts.get(reportedId) || 0) + 1
    reportCounts.set(reportedId, count)

    if (count >= 3) {
      const reportedSocket = io.sockets.sockets.get(reportedId)
      if (reportedSocket) {
        const reportedIP = reportedSocket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
                        || reportedSocket.handshake.address
        bannedIPs.add(reportedIP)
        reportedSocket.emit('banned', { message: 'You have been banned for violating community guidelines.' })
        reportedSocket.disconnect(true)
        console.log(`🔨 Auto-banned: ${reportedId} (${reportedIP}) after ${count} reports`)
      }
    }
  })

  // ── 6. Disconnect ─────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`)
    removeFromWaiting(socket.id)
    leaveRoom(socket)
    userSessions.delete(socket.id)
    socketEventCounts.delete(socket.id)
  })

  // ── leaveRoom ─────────────────────────────────────────────
  const leaveRoom = (socket) => {
    const session = userSessions.get(socket.id)
    if (!session?.room) return
    const { room, partnerId } = session
    if (partnerId) {
      io.to(partnerId).emit('partner_left')
      const ps = userSessions.get(partnerId)
      if (ps) userSessions.set(partnerId, { ...ps, room: null, partnerId: null })
    }
    socket.leave(room)
    activeRooms.delete(room)
    userSessions.set(socket.id, { ...session, room: null, partnerId: null })
  }
})

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    activeRooms: activeRooms.size,
    waitingUsers: waitingSet.size,
    queues: {
      male:   waitingQueues.male.length,
      female: waitingQueues.female.length,
      other:  waitingQueues.other.length,
    },
    totalConnected: io.engine.clientsCount
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`))
