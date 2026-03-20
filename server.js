const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

let waitingPool = []
const activeRooms = new Map()
const userSessions = new Map()

const generateRoomId = () =>
  `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Both users must be mutually compatible
const isCompatible = (userGender, userPref, candidateGender, candidatePref) => {
  const iWantThem = userPref === 'any' || userPref === candidateGender
  const theyWantMe = candidatePref === 'any' || candidatePref === userGender
  return iWantThem && theyWantMe
}

const findMatch = (socket, filters = {}) => {
  const { gender = 'other', pref = 'any' } = filters
  const index = waitingPool.findIndex(u => {
    if (u.socketId === socket.id) return false
    return isCompatible(gender, pref, u.gender, u.pref)
  })
  if (index !== -1) {
    const partner = waitingPool[index]
    waitingPool.splice(index, 1)
    return partner
  }
  return null
}

io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`)
  userSessions.set(socket.id, { room: null, partnerId: null, reportCount: 0, gender: 'other', pref: 'any' })

  socket.on('find_match', (data = {}) => {
    const session = userSessions.get(socket.id)
    const { gender = 'other', pref = 'any' } = data
    userSessions.set(socket.id, { ...session, gender, pref })
    if (session.room) leaveRoom(socket)
    const partner = findMatch(socket, { gender, pref })
    if (partner) {
      const roomId = generateRoomId()
      socket.join(roomId)
      partner.socket.join(roomId)
      userSessions.set(socket.id, { room: roomId, partnerId: partner.socketId, reportCount: session.reportCount, gender, pref })
      userSessions.set(partner.socketId, { room: roomId, partnerId: socket.id, reportCount: userSessions.get(partner.socketId)?.reportCount || 0, gender: partner.gender, pref: partner.pref })
      activeRooms.set(roomId, [socket.id, partner.socketId])
      socket.emit('match_found', { roomId, initiator: true, partnerGender: partner.gender })
      partner.socket.emit('match_found', { roomId, initiator: false, partnerGender: gender })
      console.log(`🎯 Matched: ${socket.id}(${gender},wants:${pref}) <-> ${partner.socketId}(${partner.gender},wants:${partner.pref})`)
    } else {
      waitingPool.push({ socketId: socket.id, socket, gender, pref })
      socket.emit('waiting')
      console.log(`⏳ Waiting: ${socket.id} | gender:${gender} pref:${pref} | pool:${waitingPool.length}`)
    }
  })

  socket.on('offer', ({ roomId, offer }) => { socket.to(roomId).emit('offer', offer) })
  socket.on('answer', ({ roomId, answer }) => { socket.to(roomId).emit('answer', answer) })
  socket.on('ice_candidate', ({ roomId, candidate }) => { socket.to(roomId).emit('ice_candidate', candidate) })

  socket.on('next', () => {
    leaveRoom(socket)
    const session = userSessions.get(socket.id)
    const { gender = 'other', pref = 'any' } = session || {}
    const partner = findMatch(socket, { gender, pref })
    if (partner) {
      const roomId = generateRoomId()
      socket.join(roomId)
      partner.socket.join(roomId)
      userSessions.set(socket.id, { ...userSessions.get(socket.id), room: roomId, partnerId: partner.socketId })
      userSessions.set(partner.socketId, { ...userSessions.get(partner.socketId), room: roomId, partnerId: socket.id })
      activeRooms.set(roomId, [socket.id, partner.socketId])
      socket.emit('match_found', { roomId, initiator: true, partnerGender: partner.gender })
      partner.socket.emit('match_found', { roomId, initiator: false, partnerGender: gender })
    } else {
      waitingPool.push({ socketId: socket.id, socket, gender, pref })
      socket.emit('waiting')
    }
  })

  socket.on('report_user', ({ reportedId, reason }) => {
    console.log(`🚨 Report: ${socket.id} reported ${reportedId} for: ${reason}`)
    socket.emit('report_received', { message: 'Report submitted. Thank you.' })
  })

  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`)
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id)
    leaveRoom(socket)
    userSessions.delete(socket.id)
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
  res.json({ status: 'running', activeRooms: activeRooms.size, waitingUsers: waitingPool.length, totalConnected: io.engine.clientsCount })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`) })
