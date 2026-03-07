/**
 * migrate-passwords.js — Convert plain text passwords in users.json to bcrypt hashes
 *
 * Usage:
 *   node migrate-passwords.js
 *
 * What it does:
 *   - Reads users.json
 *   - For each user that has a plain `password` field (not yet hashed),
 *     hashes it with bcrypt and saves it as `passwordHash`
 *   - Removes the plain `password` field
 *   - Writes the updated users.json
 *   - Skips users that already have a `passwordHash` field
 *
 * Safe to run multiple times — already-migrated users are skipped.
 */

const bcrypt = require('bcryptjs')
const fs = require('fs')
const path = require('path')

const BCRYPT_ROUNDS = 12
const USERS_FILE = path.join(__dirname, 'users.json')

// ── Load ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(USERS_FILE)) {
  console.error('users.json not found in', __dirname)
  process.exit(1)
}

let users
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
} catch (err) {
  console.error('Failed to parse users.json:', err.message)
  process.exit(1)
}

if (!Array.isArray(users)) {
  console.error('users.json should be an array')
  process.exit(1)
}

// ── Migrate ───────────────────────────────────────────────────────────────────

const toMigrate = users.filter(u => u.password && !u.passwordHash)
const alreadyDone = users.filter(u => u.passwordHash)

if (toMigrate.length === 0) {
  console.log(`✓ Nothing to migrate — all ${alreadyDone.length} user(s) already have hashed passwords.`)
  process.exit(0)
}

console.log(`Found ${toMigrate.length} user(s) to migrate, ${alreadyDone.length} already done.`)
console.log(`Hashing with bcrypt (${BCRYPT_ROUNDS} rounds) — this may take a moment...\n`)

for (const user of toMigrate) {
  process.stdout.write(`  Hashing ${user.userId}... `)
  user.passwordHash = bcrypt.hashSync(user.password, BCRYPT_ROUNDS)
  delete user.password
  console.log('done')
}

// ── Save ──────────────────────────────────────────────────────────────────────

// Write to a backup first, then overwrite
const backupPath = USERS_FILE + '.bak'
fs.copyFileSync(USERS_FILE, backupPath)
console.log(`\nBackup saved to users.json.bak`)

fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
console.log(`✓ users.json updated — ${toMigrate.length} password(s) migrated successfully.`)
