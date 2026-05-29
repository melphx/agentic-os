# Claude OS — VPS Deployment Guide (Ubuntu 24.04)

## 1. Install dependencies on VPS

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential

# PM2 (process manager)
sudo npm install -g pm2

# Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull Hermes model (choose one)
ollama pull nous-hermes2          # ~7GB, fast, recommended
# ollama pull nous-hermes2:13b    # larger, smarter
# ollama pull hermes3             # newest (Llama 3.1 based)
```

## 2. Clone and configure

```bash
git clone https://github.com/melphx/agentic-os.git
cd agentic-os/claude-os

cp .env.local.example .env.local
nano .env.local
```

Fill in `.env.local`:
```
JWT_SECRET=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
SEED_KEY=pick-a-secret-word
OLLAMA_BASE_URL=http://localhost:11434/v1
HERMES_MODEL=nous-hermes2
```

## 3. Install & build

```bash
npm install
npm run build
```

## 4. Create your admin user (one-time)

```bash
curl -X POST http://localhost:3000/api/auth/seed \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword","seedKey":"pick-a-secret-word"}'
```

> Run this AFTER starting the server in step 5, then you can remove or ignore the seed endpoint.

## 5. Start with PM2

```bash
pm2 start npm --name "claude-os" -- start
pm2 save
pm2 startup   # run the printed command to survive reboots
```

App runs on **http://your-server-ip:3000**

## 6. Nginx reverse proxy (optional but recommended)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo nano /etc/nginx/sites-available/claude-os
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/claude-os /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx

# Free HTTPS
sudo certbot --nginx -d yourdomain.com
```

## 7. Push updates

```bash
# On VPS — pull latest and rebuild
cd agentic-os/claude-os
git pull
npm install
npm run build
pm2 restart claude-os
```

## Ollama is running but Hermes is slow?

Add more RAM or use the smaller quantised model:
```bash
ollama pull nous-hermes2:q4_0   # 4-bit quantised, much faster
```

Check Ollama is up: `curl http://localhost:11434/api/tags`
