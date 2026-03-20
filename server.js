// ============================================================
// FILE: server/server.js
// PURPOSE: Main signaling server for WebRTC + random matching
// RUN: node server.js
// DEPLOY TO: AWS EC2 / Railway / Render
// ============================================================

const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const mongoose = require('mongoose')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

// ── In-memory waiting pool ─────────────────────────────────
// Stores users waiting for a match
// { socketId, socket, gender, interests }
let waitingPool = []

// Active rooms: roomId → [socketId1, socketId2]
const activeRooms = new Map()

// User data: socketId → { room, partnerId, reportCount }
const userSessions = new Map()

// ── Utility ────────────────────────────────────────────────
const generateRoomId = () =>
  `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

const findMatch = (socket, filters = {}) => {
  // Find first compatible waiting user
  const index = waitingPool.findIndex(
    (u) => u.socketId !== socket.id
  )
  if (index !== -1) {
    const partner = waitingPool[index]
    waitingPool.splice(index, 1) // remove from pool
    return partner
  }
  return null
}

// ── Socket Events ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`)

  // Initialize session
  userSessions.set(socket.id, {
    room: null,
    partnerId: null,
    reportCount: 0
  })

  // ── 1. Find Match ────────────────────────────────────────
  socket.on('find_match', (data = {}) => {
    const session = userSessions.get(socket.id)

    // If already in a room, leave it first
    if (session.room) {
      leaveRoom(socket)
    }

    const partner = findMatch(socket, data)

    if (partner) {
      // Match found — create room
      const roomId = generateRoomId()

      // Both join the room
      socket.join(roomId)
      partner.socket.join(roomId)

      // Update sessions
      userSessions.set(socket.id, {
        room: roomId,
        partnerId: partner.socketId,
        reportCount: session.reportCount
      })
      userSessions.set(partner.socketId, {
        room: roomId,
        partnerId: socket.id,
        reportCount: userSessions.get(partner.socketId).reportCount
      })

      activeRooms.set(roomId, [socket.id, partner.socketId])

      // Notify both users
      socket.emit('match_found', { roomId, initiator: true })
      partner.socket.emit('match_found', { roomId, initiator: false })

      console.log(`🎯 Matched: ${socket.id} ↔ ${partner.socketId} in ${roomId}`)
    } else {
      // No match yet — add to waiting pool
      waitingPool.push({ socketId: socket.id, socket })
      socket.emit('waiting')
      console.log(`⏳ Waiting: ${socket.id} | Pool size: ${waitingPool.length}`)
    }
  })

  // ── 2. WebRTC Signaling ──────────────────────────────────
  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', offer)
  })

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', answer)
  })

  socket.on('ice_candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice_candidate', candidate)
  })

  // ── 3. Next / Skip ───────────────────────────────────────
  socket.on('next', () => {
    leaveRoom(socket)
    // Auto find new match
    const partner = findMatch(socket)
    if (partner) {
      const roomId = generateRoomId()
      socket.join(roomId)
      partner.socket.join(roomId)

      userSessions.set(socket.id, {
        ...userSessions.get(socket.id),
        room: roomId,
        partnerId: partner.socketId
      })
      userSessions.set(partner.socketId, {
        ...userSessions.get(partner.socketId),
        room: roomId,
        partnerId: socket.id
      })

      activeRooms.set(roomId, [socket.id, partner.socketId])
      socket.emit('match_found', { roomId, initiator: true })
      partner.socket.emit('match_found', { roomId, initiator: false })
    } else {
      waitingPool.push({ socketId: socket.id, socket })
      socket.emit('waiting')
    }
  })

  // ── 4. Report User ───────────────────────────────────────
  socket.on('report_user', ({ reportedId, reason }) => {
    console.log(`🚨 Report: ${socket.id} reported ${reportedId} for: ${reason}`)
    // In production: save to DB and auto-ban after threshold
    socket.emit('report_received', { message: 'Report submitted. Thank you.' })
  })

  // ── 5. Disconnect ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`)

    // Remove from waiting pool
    waitingPool = waitingPool.filter((u) => u.socketId !== socket.id)

    // Notify partner
    leaveRoom(socket)

    userSessions.delete(socket.id)
  })

  // ── Helper: Leave current room ───────────────────────────
  const leaveRoom = (socket) => {
    const session = userSessions.get(socket.id)
    if (!session || !session.room) return

    const { room, partnerId } = session

    // Notify partner
    if (partnerId) {
      io.to(partnerId).emit('partner_left')
      // Reset partner session
      const partnerSession = userSessions.get(partnerId)
      if (partnerSession) {
        userSessions.set(partnerId, {
          ...partnerSession,
          room: null,
          partnerId: null
        })
      }
    }

    socket.leave(room)
    activeRooms.delete(room)

    userSessions.set(socket.id, {
      ...session,
      room: null,
      partnerId: null
    })
  }
})

// ── Health check endpoint ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    activeRooms: activeRooms.size,
    waitingUsers: waitingPool.length,
    totalConnected: io.engine.clientsCount
  })
})

// ── Start server ───────────────────────────────────────────
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`)
})