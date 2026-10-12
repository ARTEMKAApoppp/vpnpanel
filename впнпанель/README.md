# VPN Panel

Веб-панель для управления VPN на базе **Xray (VLESS + Reality)**: пользователи, подписки, лимиты трафика и сроков, QR-коды.

## Установка (одна команда, от root)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ARTEMKAApoppp/vpnpanel/main/install.sh)
```

Или через git:

```bash
git clone https://github.com/ARTEMKAApoppp/vpnpanel.git && cd vpnpanel && bash install.sh
```

В конце установщик покажет адрес панели, логин и пароль (они также сохранены в `/opt/vpnpanel/.env`).

## Команды

```bash
bash install.sh update      # обновить панель
bash install.sh uninstall   # удалить панель
```

## Возможности

- Дашборд: статус Xray, пользователи, трафик, нагрузка сервера
- Пользователи: лимит трафика, срок, продление, сброс, вкл/выкл, удаление
- Подписки: ссылка `/sub/...`, QR-код, страница с кнопками для v2RayTun / Happ / Hiddify
- Автоотключение при исчерпании лимита или окончании срока
- Настройки: название, IP/домен, порт, SNI, публичный URL

## Заметки

- Панель работает по HTTP на порту 8080. Для HTTPS поставьте перед ней nginx/caddy с доменом и укажите его в настройках.
- VPN слушает порт 443. Если он занят — смените порт в настройках панели.
