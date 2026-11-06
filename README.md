# Trueson 1st Badminton Championship

Scores, standings and the bracket for the internal mixed-doubles tournament, in Vietnamese and English. Organizers enter results on the hidden admin page (`#admin`) with a shared PIN; everyone else just watches.

How it behaves: [docs/SPEC.md](docs/SPEC.md). How it's built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it on your computer

```sh
source ~/.nvm/nvm.sh && nvm use     # Node 22, from .nvmrc
npm install
ADMIN_PIN=choose-a-pin npm start    # http://localhost:3000 (organizers: http://localhost:3000/#admin)
```

Tests:

```sh
npm test            # rules, API, both languages
npm run test:ui     # pages in a phone-sized browser (first time: npx playwright install chromium)
```

To try the Docker setup exactly as it runs on the droplet: `cp .env.example .env`, put a PIN in it, then `docker compose up -d --build` and open http://localhost:8080.

## Deploy to the DigitalOcean droplet

The droplet already runs another service. This app gets its own folder (`/opt/badminton`), its own Docker Compose project (`badminton`) and its own port (8080), so nothing of the other service is touched.

In the commands below, replace `<user>` and `<droplet-ip>` with your SSH user and the droplet's address. If your user isn't in the `docker` group, put `sudo` in front of the `docker` commands.

### 1. Check the droplet (once)

```sh
ssh <user>@<droplet-ip>
docker compose version          # must be v2 or newer
sudo ss -tlnp | grep ':8080 '   # no output means port 8080 is free
free -h                         # about 200 MB free memory or more
```

If 8080 is taken, change `"8080:3000"` in `docker-compose.yml` to a free port, and use that port everywhere below. If memory is short, add a 1 GB swap file.

### 2. Open port 8080 (once)

In the DigitalOcean control panel, open **Networking → Firewalls**, pick the droplet's firewall, and add an inbound rule: **TCP 8080, all IPv4 and IPv6**. Keep SSH (22) limited to your own IP. Ports that Docker publishes ignore `ufw`, so this firewall is what controls access. If the droplet has no DigitalOcean firewall, the port is already open.

### 3. Check that the office Wi-Fi can reach port 8080 (once)

Some company networks only allow ports 80 and 443. On the droplet:

```sh
docker run --rm -p 8080:80 nginx
```

On a phone on the office Wi-Fi, open `http://<droplet-ip>:8080`. If you see "Welcome to nginx!", it works. Press Ctrl+C on the droplet to stop it.

### 4. Copy the code (from your computer, in this folder)

```sh
ssh <user>@<droplet-ip> 'sudo mkdir -p /opt/badminton && sudo chown $USER /opt/badminton'
rsync -av --exclude node_modules --exclude data --exclude .env --exclude .git --exclude icons \
  --exclude test-results --exclude playwright-report ./ <user>@<droplet-ip>:/opt/badminton/
```

### 5. Start it (on the droplet)

```sh
cd /opt/badminton
cp .env.example .env && nano .env              # ADMIN_PIN=... at least 6 characters, not used anywhere else
mkdir -p data && sudo chown 1000:1000 data     # the app runs as user 1000 inside the container
docker compose up -d --build
docker compose logs -f                         # wait for "Listening on http://localhost:3000", then Ctrl+C
```

Open `http://<droplet-ip>:8080` on your phone. Chrome may ask once before opening a site without HTTPS; tap **Continue to site**. Organizers go to `http://<droplet-ip>:8080/#admin` and enter the PIN.

The app restarts by itself after a crash or a droplet reboot.

## Update after a change

Run the `rsync` command from step 4 again, then on the droplet:

```sh
cd /opt/badminton && docker compose up -d --build
```

Results in `data/` are kept. To move the planned match times (for example a later start), change `"start"` in the `schedule` line at the top of `server/seed.json` and update the same way. After changing `.env`, run `docker compose up -d`; a plain restart doesn't pick up the new PIN.

## Back up and restore

On the droplet, any time (for example after each match day):

```sh
cd /opt/badminton && docker compose exec app npm run backup    # saves data/backup-<UTC date and time>.db
```

Then copy it to your computer, from your computer:

```sh
scp '<user>@<droplet-ip>:/opt/badminton/data/backup-*.db' .
```

“Xóa tất cả” (Clear All) on the admin page also saves `data/backup-before-clear-<UTC date and time>.db` before it clears anything.

To restore a backup:

```sh
cd /opt/badminton
docker compose down
sudo cp data/<backup file>.db data/tournament.db
docker compose up -d
```

## Reset after the rehearsal

On the admin page, tap **Xóa tất cả** (Clear All) and type the PIN again. The rehearsal is saved in **Lịch sử** (History, the button next to Clear All) and as a backup file first. Delete the rehearsal's History entry there if you don't want to keep it. Clear All also removes every vote and sets the three awards back to “not open yet”.

## Never on this droplet

Don't run `docker system prune` in any form, and don't run `docker compose down` outside `/opt/badminton`. Both can remove the other service's containers, images or data.

## If something goes wrong

| What you see | What to do |
|---|---|
| The site doesn't load | `docker compose ps` should say “running”; check `docker compose logs`; check the firewall rule for 8080 (step 2) and the office network (step 3) |
| `ADMIN_PIN must be set to at least 6 characters.` in the logs | Fix `.env`, then `docker compose up -d` |
| `unable to open database file` in the logs | `sudo chown 1000:1000 data`, then `docker compose restart` |
| Organizers see “Nhập sai quá nhiều lần” (too many wrong PINs) | Wait 15 minutes, or `docker compose restart` to clear the count |
| Chrome warns that the site isn't secure | Expected without HTTPS: tap “Continue to site” once |
