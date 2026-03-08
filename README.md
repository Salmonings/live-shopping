# Bestway Supermarket — Live Shopping System

A WebRTC-based video ordering platform for Bestway Supermarket. Customers place live video calls to order takers who help them shop remotely. Managers monitor all branches in real time.

---

## How It Works

1. Customer visits the site, enters their name, phone, and delivery address
2. They join a queue for their nearest branch (auto-detected by GPS)
3. An available order taker receives the call, sees customer details, and accepts
4. Both sides connect via WebRTC for a live video/audio call
5. The order is placed and fulfilled during the call
6. Manager dashboard shows all active calls, queue sizes, and order taker status across all branches

---

## Pages

| URL | Who uses it | Description |
|-----|-------------|-------------|
| `/` | Customers | Join queue, wait, video call |
| `/order-taker` | Staff | Login, go available, take calls |
| `/manager` | Managers | Live dashboard of all branches |

---

## Project Structure

```
app/
  page.tsx              # Customer page
  order-taker/
    page.tsx            # Order taker page
  manager/
    page.tsx            # Manager dashboard
  globals.css           # All styling — fonts, colors, layout
  layout.tsx            # Root layout — imports CSS, sets page title
  useCallDuration.ts    # Shared call timer hook

server.js               # Custom HTTPS + Socket.io server
create-user.js          # CLI tool to create order taker / manager accounts
migrate-passwords.js    # Migrates plain text passwords to bcrypt hashes
branches.json           # Branch list with names, coordinates, WhatsApp numbers (never commit this)
users.json              # User accounts (never commit this)
logs/                   # Monthly log files (auto-created, never commit)
public/
  favicon.jpg
  ringtone.mp3
```

---

## Setup

### Requirements

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Configure branches

Edit `branches.json`:

```json
[
  {
    "id": "cairo-branch",
    "name": "Cairo Branch",
    "lat": 30.0444,
    "lng": 31.2357,
    "whatsapp": "201012345678"
  }
]
```

The `whatsapp` number must be in international format without the `+`. It is optional — branches without it won't appear in the WhatsApp selector.

### Create user accounts

```bash
# Order taker assigned to a specific branch
node create-user.js ahmed password123 order_taker cairo-branch

# Roaming order taker (can log in to any branch)
node create-user.js sara password123 order_taker

# Manager (access to all branches)
node create-user.js manager1 password123 manager
```
### Change ringtone or Favicon

Located in `public\ringtone.mp3` and `public\favicon.jpg` respectively. Best size for a favicon is 48x48. Place and rename files as required.

---

## Running

### Development

```bash
npm run dev
```

The server generates a self-signed SSL certificate automatically. Your browser will show a security warning — click **Advanced → Proceed anyway**.

To test on a phone over WiFi, go to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `https://YOUR_LOCAL_IP:3000`, enable, and relaunch Chrome.

### Production

Set these environment variables (in `.env` or your server environment):

```env
NODE_ENV=production
SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
TURN_URL=turn:turn.yourdomain.com:3478
TURN_USER=supermarket
TURN_PASS=your_turn_password
ALLOWED_ORIGINS=https://order.yourdomain.com
```

Then build and start:

```bash
npm run build
node server.js
```

---

## Deployment (Hostinger VPS)

### First time

1. SSH into your VPS
2. Install Node.js, Nginx, Certbot, coturn
3. Upload project files via FileZilla (SFTP to `/var/www/bestway`)
4. Create `.env` and `users.json` directly on the server
5. Run `npm install && npm run build`
6. Set up systemd service (see below)
7. Get SSL certificate with Certbot
8. Configure Nginx reverse proxy

### Systemd service

Create `/etc/systemd/system/bestway.service`:

```ini
[Unit]
Description=Bestway Live Shopping
After=network.target

[Service]
WorkingDirectory=/var/www/bestway
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
EnvironmentFile=/var/www/bestway/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable bestway
systemctl start bestway
```

### Updating

Upload changed files via FileZilla, then:

```bash
# If you changed any app/ files or globals.css
npm run build
systemctl restart bestway

# If you only changed server.js or .env
systemctl restart bestway
```

---

## TURN Server (coturn)

Required for calls between users on different networks (mobile data, different ISPs). Without it, most calls still work on the same WiFi but will fail on real networks.

Install:
```bash
apt install coturn
```

Configure `/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=5349
external-ip=YOUR_VPS_IP
realm=turn.yourdomain.com
lt-cred-mech
user=supermarket:YOUR_TURN_PASSWORD
cert=/etc/letsencrypt/live/order.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/order.yourdomain.com/privkey.pem
```

Open firewall ports:
```bash
ufw allow 3478
ufw allow 3478/udp
ufw allow 5349
```

---

## Logs

All events are written to `logs/YYYY-MM.txt` and `logs/YYYY-MM.json` automatically.

Logged events:

| Event | What's recorded |
|-------|----------------|
| `login_success` | userId, role, branch |
| `login_failed` | userId, reason, IP |
| `customer_joined_queue` | name, phone, address, branch |
| `order_taker_available` | userId, branch |
| `order_taker_offline` | userId, branch |
| `order_taker_logout` | userId, branch |
| `call_started` | order taker, customer details, branch |
| `call_ended` | order taker, customer details, duration |

Plain text example:
```
[2026-03-08 14:32:01] CALL_STARTED          orderTaker=ahmed  branchId=cairo-branch  customerName=Mohamed Ali  customerPhone=201012345678
[2026-03-08 14:45:17] CALL_ENDED            orderTaker=ahmed  branchId=cairo-branch  customerName=Mohamed Ali  duration=13:16
```

---

## Security

- Passwords stored as bcrypt hashes (never plain text)
- TURN credentials served from server — never exposed in client source
- Rate limiting on login, queue join, and WebRTC signaling
- WebRTC signals only relayed between verified paired sockets
- CORS restricted to `ALLOWED_ORIGINS` in production
- Branch assignment enforced per user (roaming users can opt out)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, TypeScript |
| Styling | Plain CSS (globals.css) |
| Realtime | Socket.io |
| Video/Audio | WebRTC (MediaDevices API) |
| Server | Node.js, HTTPS |
| Auth | bcryptjs |
| TURN | coturn |
| Reverse proxy | Nginx |
| SSL | Let's Encrypt (Certbot) |

---

## WhatsApp Integration

Each branch can have a WhatsApp number set in `branches.json`. A floating button on the customer page lets them open a WhatsApp chat directly with their branch to change orders or ask questions.

Number format: international without `+` — e.g. `201012345678` not `+201012345678`.

---

## Notes

- All server state is in memory. If the server restarts, active calls and queues are cleared. This is intentional for simplicity — Redis would be needed at scale.
- `users.json`, `branches.json` and `.env` must be created manually on the server and are never committed to git.
- Logs rotate automatically by month. Archive or delete old log files periodically to manage disk space.
