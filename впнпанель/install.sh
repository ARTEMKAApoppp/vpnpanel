#!/usr/bin/env bash
# VPN Panel installer — Xray (VLESS + Reality) + web panel
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/ARTEMKAApoppp/vpnpanel/main/install.sh)
#   or: git clone https://github.com/ARTEMKAApoppp/vpnpanel.git && cd vpnpanel && bash install.sh
#   bash install.sh update | uninstall
REPO="ARTEMKAApoppp/vpnpanel"
APP=/opt/vpnpanel
LOG=/tmp/vpnpanel-install.log
PANEL_PORT="${PANEL_PORT:-8080}"
ADMIN_USER="${ADMIN_USER:-admin}"
: > "$LOG"

# ---------- ui ----------
if [ -t 1 ]; then
  R=$'\e[0m'; B=$'\e[1m'; D=$'\e[2m'; P=$'\e[38;5;141m'; C=$'\e[38;5;45m'; G=$'\e[38;5;48m'; E=$'\e[38;5;203m'; Y=$'\e[38;5;215m'
else R=; B=; D=; P=; C=; G=; E=; Y=; fi

banner() {
  clear 2>/dev/null || true
  echo
  echo "${P}${B}   __   ______  _  _    ____   _   _  _  _____ _     "
  echo "${P}   \\ \\ / /  _ \\| \\| |  |  _ \\ /_\\ | \\| || ||  ___| |    "
  echo "${C}    \\ V /| |_) | .\` |  | |_) / _ \\| .\` || || |_  | |__  "
  echo "${C}     \\_/ |  __/|_|\\_|  |_|  /_/ \\_\\_|\\_||_||_|___||____| ${R}"
  echo "${D}   ───────────────────────────────────────────────────${R}"
  echo "${D}    VLESS · Reality · Xray · подписки · веб-панель${R}"
  echo
}

TOTAL=7; N=0
step() {
  local msg="$1"; shift
  N=$((N+1))
  ( "$@" ) >>"$LOG" 2>&1 &
  local pid=$! i=0 fr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C}%s${R} ${D}[%d/%d]${R} %s" "${fr:i++%10:1}" "$N" "$TOTAL" "$msg"; sleep 0.1
  done
  tput cnorm 2>/dev/null || true
  if wait "$pid"; then printf "\r  ${G}✔${R} ${D}[%d/%d]${R} %s\033[K\n" "$N" "$TOTAL" "$msg"
  else
    printf "\r  ${E}✖${R} ${D}[%d/%d]${R} %s\033[K\n" "$N" "$TOTAL" "$msg"
    echo; echo "  ${E}Ошибка установки.${R} Лог: ${B}$LOG${R}"; echo "${D}$(tail -n 12 "$LOG")${R}"; exit 1
  fi
}

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo bash install.sh"; exit 1; }

if [ "$1" = "uninstall" ]; then
  systemctl disable --now vpnpanel 2>/dev/null || true
  rm -f /etc/systemd/system/vpnpanel.service; systemctl daemon-reload
  echo "${G}Панель удалена.${R} Данные остались в $APP/data, Xray не тронут."; exit 0
fi

# ---------- steps ----------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

s_deps() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive; apt-get update -y; apt-get install -y curl unzip ca-certificates openssl
  elif command -v dnf >/dev/null; then dnf install -y curl unzip ca-certificates openssl
  elif command -v yum >/dev/null; then yum install -y curl unzip ca-certificates openssl
  fi
}
s_node() {
  if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 16 ]; then return 0; fi
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -; (dnf install -y nodejs || yum install -y nodejs)
  fi
}
s_xray() {
  [ -x /usr/local/bin/xray ] && return 0
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
  systemctl enable xray || true
}
s_files() {
  mkdir -p "$APP/data"
  if [ -f "$SELF_DIR/server.js" ] && [ -f "$SELF_DIR/index.html" ]; then
    cp "$SELF_DIR/server.js" "$SELF_DIR/index.html" "$APP/"
  else
    for br in main master; do
      if curl -fsSL "https://raw.githubusercontent.com/$REPO/$br/server.js" -o "$APP/server.js" &&
         curl -fsSL "https://raw.githubusercontent.com/$REPO/$br/index.html" -o "$APP/index.html"; then return 0; fi
    done
    return 1
  fi
}
s_config() {
  if [ ! -f "$APP/.env" ]; then
    ADMIN_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)"
    SERVER_HOST="$(curl -fsS4 --max-time 8 https://api.ipify.org || curl -fsS4 --max-time 8 https://ifconfig.me || hostname -I | awk '{print $1}')"
    cat > "$APP/.env" <<ENV
PANEL_PORT=$PANEL_PORT
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
SERVER_HOST=$SERVER_HOST
ENV
    chmod 600 "$APP/.env"
  fi
}
s_service() {
  cat > /etc/systemd/system/vpnpanel.service <<UNIT
[Unit]
Description=VPN Panel
After=network.target

[Service]
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=PANEL_DIR=$APP
ExecStart=$(command -v node) $APP/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable vpnpanel; systemctl restart vpnpanel
}
s_firewall() {
  . "$APP/.env"
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow "$PANEL_PORT"/tcp; ufw allow 443/tcp; fi
  if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$PANEL_PORT"/tcp; firewall-cmd --permanent --add-port=443/tcp; firewall-cmd --reload
  fi
  true
}

# ---------- run ----------
banner
if [ "$1" = "update" ]; then
  TOTAL=2
  step "Скачиваю последнюю версию панели" s_files
  step "Перезапускаю панель" systemctl restart vpnpanel
  echo; echo "  ${G}${B}Обновлено!${R}"; echo; exit 0
fi

step "Устанавливаю системные пакеты" s_deps
step "Устанавливаю Node.js" s_node
step "Устанавливаю Xray-core" s_xray
step "Копирую файлы панели" s_files
step "Создаю логин и пароль" s_config
step "Запускаю службу панели" s_service
step "Настраиваю файрвол" s_firewall

sleep 1
. "$APP/.env"
echo
echo "  ${P}╔══════════════════════════════════════════════════╗${R}"
echo "  ${P}║${R}  ${G}${B}✔ VPN Panel успешно установлена!${R}                  ${P}║${R}"
echo "  ${P}╠══════════════════════════════════════════════════╣${R}"
printf "  ${P}║${R}  ${D}Панель${R}   ${C}${B}%-39s${R}${P}║${R}\n" "http://$SERVER_HOST:$PANEL_PORT"
printf "  ${P}║${R}  ${D}Логин${R}    ${Y}${B}%-39s${R}${P}║${R}\n" "$ADMIN_USER"
printf "  ${P}║${R}  ${D}Пароль${R}   ${Y}${B}%-39s${R}${P}║${R}\n" "$ADMIN_PASS"
echo "  ${P}╚══════════════════════════════════════════════════╝${R}"
echo
echo "  ${D}Данные для входа сохранены в $APP/.env${R}"
echo "  ${D}Обновить: bash install.sh update   Удалить: bash install.sh uninstall${R}"
echo "  ${D}Порт 443 занят? Смените порт VPN в настройках панели.${R}"
echo
