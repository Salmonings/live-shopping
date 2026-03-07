/**
 * create-user.js — Add a user to users.json with a bcrypt-hashed password
 *
 * Usage:
 *   node create-user.js <userId> <password> <role> [branchId]
 *
 * Examples:
 *   node create-user.js ahmed secret123 order_taker cairo-branch
 *   node create-user.js manager1 adminpass manager
 *
 * Roles: order_taker, manager
 */

const bcrypt = require('bcryptjs')
const fs = require('fs')
const path = require('path')

const BCRYPT_ROUNDS = 12
const USERS_FILE = path.join(__dirname, 'users.json')

const [,, userId, password, role, branchId] = process.argv

// ── Validate arguments ────────────────────────────────────────────────────────

if (!userId || !password || !role) {
  console.error('Usage: node create-user.js <userId> <password> <role> [branchId]')
  console.error('Roles: order_taker, manager')
  process.exit(1)
}

if (!['order_taker', 'manager'].includes(role)) {
  console.error(`Invalid role "${role}". Must be: order_taker or manager`)
  process.exit(1)
}

if (role === 'order_taker' && !branchId) {
  console.error('order_taker requires a branchId argument')
  console.error('Example: node create-user.js ahmed secret123 order_taker cairo-branch')
  process.exit(1)
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters')
  process.exit(1)
}

// ── Load existing users ───────────────────────────────────────────────────────

let users = []
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  } catch (err) {
    console.error('Failed to parse users.json:', err.message)
    process.exit(1)
  }
}

// Check for duplicate userId
if (users.find(u => u.userId === userId)) {
  console.error(`User "${userId}" already exists. Remove them from users.json first if you want to recreate.`)
  process.exit(1)
}

// ── Hash password and save ────────────────────────────────────────────────────

console.log(`Hashing password (bcrypt, ${BCRYPT_ROUNDS} rounds) — this takes a moment...`)
const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)

const newUser = {
  userId,
  passwordHash,   // never store plain text
  role,
  ...(branchId ? { branchId } : {})
}

users.push(newUser)
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))

console.log(`✓ User "${userId}" created successfully`)
console.log(`  Role:     ${role}`)
if (branchId) console.log(`  Branch:   ${branchId}`)
console.log(`  Saved to: ${USERS_FILE}`)
