#!/usr/bin/env bash
set -Eeuo pipefail

BOLD="\033[1m"; CYAN="\033[36m"; PURPLE="\033[35m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
APP_DIR="${APP_DIR:-/opt/wa-bridge}"
REPO_URL="${REPO_URL:-https://github.com/your-org/omega-v1.git}"
NODE_MAJOR="${NODE_MAJOR:-22}"

declare -A ENV_VALUES

banner(){ clear || true; printf "${CYAN}${BOLD}\n╔══════════════════════════════════════════════╗\n║        WA-BRIDGE AUTOMATED DEPLOYMENT       ║\n║   Web Dashboard • Telegram • WhatsApp MD    ║\n╚══════════════════════════════════════════════╝\n${RESET}\n"; }
info(){ printf "${CYAN}▶${RESET} %s\n" "$*"; }
ok(){ printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn(){ printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail(){ printf "${RED}✕${RESET} %s\n" "$*"; exit 1; }
prompt(){ local key="$1" label="$2" secret="${3:-false}" val=""; while [[ -z "$val" ]]; do if [[ "$secret" == true ]]; then read -rsp "$label: " val; echo; else read -rp "$label: " val; fi; done; ENV_VALUES[$key]="$val"; }
require_root(){ [[ $EUID -eq 0 ]] || fail "Run as root (or sudo bash setup.sh)."; }
collect_env(){ prompt TELEGRAM_BOT_TOKEN "Telegram bot token" true; prompt TELEGRAM_OWNER_ID "Telegram owner ID"; prompt WEB_DOMAIN "Web domain (example.com)"; read -rp "Web port [3000]: " WEB_PORT; ENV_VALUES[WEB_PORT]="${WEB_PORT:-3000}"; read -rp "Workspace root [$APP_DIR/artifacts/workspaces]: " WORKSPACE_ROOT; ENV_VALUES[WORKSPACE_ROOT]="${WORKSPACE_ROOT:-$APP_DIR/artifacts/workspaces}"; ENV_VALUES[WEB_SESSION_SECRET]="$(openssl rand -hex 32)"; while true; do read -rp "Add another .env variable? (KEY=value or blank to continue): " extra; [[ -z "$extra" ]] && break; [[ "$extra" == *=* ]] || { warn "Use KEY=value format"; continue; }; ENV_VALUES["${extra%%=*}"]="${extra#*=}"; done; }
install_system(){ info "Updating packages and installing infrastructure"; apt-get update -y; apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx build-essential openssl; if ! command -v node >/dev/null || [[ $(node -v | sed 's/v//' | cut -d. -f1) -lt $NODE_MAJOR ]]; then curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; apt-get install -y nodejs; fi; corepack enable; npm i -g pm2; ok "System packages ready"; }
install_app(){ info "Installing application in $APP_DIR"; if [[ -d "$APP_DIR/.git" ]]; then git -C "$APP_DIR" pull --ff-only; else mkdir -p "$APP_DIR"; git clone "$REPO_URL" "$APP_DIR"; fi; cd "$APP_DIR"; pnpm install --frozen-lockfile; cat > .env <<ENV
NODE_ENV=production
ENV
for key in "${!ENV_VALUES[@]}"; do printf '%s=%q\n' "$key" "${ENV_VALUES[$key]}" >> .env; done; pnpm --filter @workspace/wa-bridge build; pm2 start artifacts/wa-bridge/dist/index.js --name wa-bridge --update-env; pm2 save; pm2 startup systemd -u root --hp /root >/tmp/wa-bridge-pm2-startup.txt || true; ok "Application running under PM2"; }
configure_nginx(){ local domain="${ENV_VALUES[WEB_DOMAIN]}" port="${ENV_VALUES[WEB_PORT]}"; info "Configuring Nginx for $domain"; cat > "/etc/nginx/sites-available/wa-bridge" <<NGINX
server {
  listen 80;
  server_name $domain;
  location / {
    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/wa-bridge /etc/nginx/sites-enabled/wa-bridge; nginx -t; systemctl reload nginx; certbot --nginx -d "$domain" --non-interactive --agree-tos -m "admin@$domain" --redirect || warn "SSL provisioning failed. Verify DNS and rerun: certbot --nginx -d $domain"; ok "Reverse proxy configured"; }
main(){ banner; require_root; collect_env; install_system; install_app; configure_nginx; printf "\n${GREEN}${BOLD}Deployment complete:${RESET} https://${ENV_VALUES[WEB_DOMAIN]}\n"; }
main "$@"
