const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

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
  'https://randomchat-server-production.up.railway.app',
]

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true)
      } else {
        console.warn(`Blocked origin: ${origin}`)
        callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST']
  },
  perMessageDeflate: false,
})

let waitingPool = []
const activeRooms = new Map()
const userSessions = new Map()
const socketEventCounts = new Map()
const reportCounts = new Map()
const bannedIPs = new Set()

const generateRoomId = () =>
  `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

const isSocketRateLimited = (socketId) => {
  const now = Date.now()
  const window = 10000
  const maxEvents = 20
  if (!socketEventCounts.has(socketId)) socketEventCounts.set(socketId, [])
  const events = socketEventCounts.get(socketId).filter(t => now - t < window)
  events.push(now)
  socketEventCounts.set(socketId, events)
  return events.length > maxEvents
}

const isCompatible = (userGender, userPref, candidateGender, candidatePref) => {
  const iWantThem = userPref === 'any' || userPref === candidateGender
  const theyWantMe = candidatePref === 'any' || candidatePref === userGender
  return iWantThem && theyWantMe
}

const findMatch = (socket, filters = {}) => {
  const { gender = 'other', pref = 'any' } = filters
  const index = waitingPool.findIndex(u => {
    if (u.socketId === socket.id) return false
    if (!u.socket.connected) return false
    return isCompatible(gender, pref, u.gender, u.pref)
  })
  if (index !== -1) {
    const partner = waitingPool[index]
    waitingPool.splice(index, 1)
    return partner
  }
  return null
}

// Clean stale pool entries every 30s
setInterval(() => {
  const before = waitingPool.length
  waitingPool = waitingPool.filter(u => u.socket.connected)
  const cleaned = before - waitingPool.length
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale pool entries`)
}, 30000)

io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address

  if (bannedIPs.has(clientIP)) {
    console.log(`🚫 Banned IP tried to connect: ${clientIP}`)
    socket.disconnect(true)
    return
  }

  console.log(`✅ Connected: ${socket.id} (${clientIP})`)
  userSessions.set(socket.id, { room: null, partnerId: null, reportCount: 0, gender: 'other', pref: 'any' })

  const checkRate = () => {
    if (isSocketRateLimited(socket.id)) {
      socket.emit('error', { message: 'Rate limited. Slow down.' })
      return false
    }
    return true
  }

  // ── 1. Find Match ──────────────────────────────────────
  socket.on('find_match', (data = {}) => {
    if (!checkRate()) return
    const session = userSessions.get(socket.id)
    const { gender = 'other', pref = 'any' } = data

    const validGenders = ['male', 'female', 'other']
    const validPrefs = ['any', 'male', 'female']
    const safeGender = validGenders.includes(gender) ? gender : 'other'
    const safePref = validPrefs.includes(pref) ? pref : 'any'

    userSessions.set(socket.id, { ...session, gender: safeGender, pref: safePref })
    if (session.room) leaveRoom(socket)

    const partner = findMatch(socket, { gender: safeGender, pref: safePref })
    if (partner) {
      const roomId = generateRoomId()
      socket.join(roomId)
      partner.socket.join(roomId)
      activeRooms.set(roomId, [socket.id, partner.socketId])
      userSessions.set(socket.id, { room: roomId, partnerId: partner.socketId, reportCount: session.reportCount, gender: safeGender, pref: safePref })
      userSessions.set(partner.socketId, { room: roomId, partnerId: socket.id, reportCount: userSessions.get(partner.socketId)?.reportCount || 0, gender: partner.gender, pref: partner.pref })

      // ✅ Send partnerId so client can use it for reports
      console.log(`📤 To ${socket.id} — partnerId: ${partner.socketId}`)
      console.log(`📤 To ${partner.socketId} — partnerId: ${socket.id}`)
      socket.emit('match_found', { roomId, initiator: true, partnerGender: partner.gender, partnerId: partner.socketId })
      partner.socket.emit('match_found', { roomId, initiator: false, partnerGender: safeGender, partnerId: socket.id })

      console.log(`🎯 Matched: ${socket.id}(${safeGender}) <-> ${partner.socketId}(${partner.gender})`)
    } else {
      waitingPool.push({ socketId: socket.id, socket, gender: safeGender, pref: safePref })
      socket.emit('waiting')
    }
  })

  // ── 2. WebRTC Signaling (verified) ────────────────────
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

  // ── 3. Next ────────────────────────────────────────────
  socket.on('next', () => {
    if (!checkRate()) return
    leaveRoom(socket)
    const session = userSessions.get(socket.id)
    const { gender = 'other', pref = 'any' } = session || {}
    const partner = findMatch(socket, { gender, pref })
    if (partner) {
      const roomId = generateRoomId()
      socket.join(roomId)
      partner.socket.join(roomId)
      activeRooms.set(roomId, [socket.id, partner.socketId])
      userSessions.set(socket.id, { ...userSessions.get(socket.id), room: roomId, partnerId: partner.socketId })
      userSessions.set(partner.socketId, { ...userSessions.get(partner.socketId), room: roomId, partnerId: socket.id })
      console.log(`📤 To ${socket.id} — partnerId: ${partner.socketId}`)
      console.log(`📤 To ${partner.socketId} — partnerId: ${socket.id}`)
      socket.emit('match_found', { roomId, initiator: true, partnerGender: partner.gender, partnerId: partner.socketId })
      partner.socket.emit('match_found', { roomId, initiator: false, partnerGender: gender, partnerId: socket.id })
    } else {
      waitingPool.push({ socketId: socket.id, socket, gender, pref })
      socket.emit('waiting')
    }
  })

  // ── 4. Report with auto-ban ────────────────────────────
  socket.on('report_user', ({ reportedId, reason }) => {
    if (!checkRate()) return
    const safeReason = String(reason || '').slice(0, 200)

    // Verify reportedId is a valid connected socket
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
        const reportedIP = reportedSocket.handshake.headers['x-forwarded-for'] || reportedSocket.handshake.address
        bannedIPs.add(reportedIP)
        reportedSocket.emit('banned', { message: 'You have been banned for violating community guidelines.' })
        reportedSocket.disconnect(true)
        console.log(`🔨 Auto-banned: ${reportedId} (${reportedIP}) after ${count} reports`)
      }
    }

    socket.emit('report_received', { message: 'Report submitted. Thank you.' })
  })

  // ── 5. Disconnect ──────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`)
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id)
    leaveRoom(socket)
    userSessions.delete(socket.id)
    socketEventCounts.delete(socket.id)
  })

  const leaveRoom = (socket) => {
    const session = userSessions.get(socket.id)
    if (!session || !session.room) return
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
    waitingUsers: waitingPool.length,
    totalConnected: io.engine.clientsCount
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`) })