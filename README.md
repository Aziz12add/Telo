# Telo v2 — Cloudflare Workers Telegram Proxy Deployer

Telo v2 is a full-stack deployer and production runtime for running a high-performance Telegram proxy on **Cloudflare Workers** using modern `cloudflare:sockets` TCP connections, Durable Objects session state, and MTProxy AES-CTR obfuscation.

---

## 🇮🇷 راهنمای فارسی (Persian Documentation)

### چرا نسخه قدیمی کار نمی‌کرد؟
نسخه اولیه پروژه فقط یک تونل ساده WebSocket به TCP بود و پروتکل کلاینت MTProto تلگرام را تفکیک یا رمزنگاری نمی‌کرد. در نسخه دوم (Telo v2):
1. ورکر به صورت یک پکیج ماژولار کامل (شامل `index.js`, `session.js`, `mtproxy.js`, `protocol.js` و `metadata.json`) با متد استاندارد `multipart/form-data` در کلودفلر بارگذاری می‌شود.
2. با استفاده از قابلیت مدرن `cloudflare:sockets` ارتباط مستقیم TCP به سرورهای رسمی تلگرام (دیتاسنتر اصلی ۲ در آمستردام: `149.154.167.51:443`) برقرار می‌شود.
3. کلاس `ProxySessionDO` بر بستر Durable Objects مدیریت سشن‌ها، جریان داده و بافرها را به طور اختصاصی کنترل می‌کند.
4. توکن‌های API کلودفلر فقط در حافظه رم نگهداری شده و هرگز در هیچ پایگاه‌داده‌ای ذخیره نمی‌شوند.

### راهنمای دریافت توکن Cloudflare API (طی ۳۰ ثانیه):
1. وارد داشبورد کلودفلر شده و به صفحه توکن‌ها بروید:
   [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. روی دکمه **Create Token** کلیک کنید.
3. در قالب **Edit Cloudflare Workers** روی **Use template** کلیک کنید.
4. اطمینان حاصل کنید دسترسی‌های زیر وجود دارند:
   - `Account` -> `Workers Scripts` -> `Edit`
   - `Account` -> `Workers Subdomain` -> `Edit`
   - `Account` -> `Account Settings` -> `Read`
5. دکمه **Continue to summary** و سپس **Create Token** را بزنید و توکن تولید شده را در برنامه وارد کنید.

### نحوه اتصال در تلگرام
پس از زدن دکمه دیپلوی، لینک‌های استاندارد تلگرام به صورت زیر تولید می‌شوند:
- **لینک مستقیم:** `tg://proxy?server=YOUR_WORKER.workers.dev&port=443&secret=32_HEX_SECRET`
- **لینک تحت وب:** `https://t.me/proxy?server=YOUR_WORKER.workers.dev&port=443&secret=32_HEX_SECRET`
- **سنجش زنده سلامت:** `https://YOUR_WORKER.workers.dev/healthz`

### محدودیت‌ها و قوانین کلودفلر (Cloudflare Terms of Service)
- در پلن رایگان کلودفلر (Workers Free)، محدودیت ۱۰۰,۰۰۰ درخواست در روز وجود دارد که برای چت، چنل‌ها و دانلود فایل‌های عادی مناسب است.
- تماس صوتی و تصویری تلگرام معمولاً بر بستر پروتکل UDP بوده و از مسیر P2P تلگرام می‌گذرد.

---

## 🇬🇧 English Documentation

### Architecture Overview
Telo v2 utilizes Cloudflare Workers' latest capabilities:
- **Direct TCP Sockets**: Connects directly to official Telegram data centers (`149.154.175.50:443`, `149.154.167.51:443`, etc.) using `cloudflare:sockets`.
- **Durable Objects (SQLite storage)**: Isolates client sessions in `ProxySessionDO` with window credit flow control and ingress/egress stream backpressure.
- **Multipart Upload**: Deploys via Cloudflare v4 REST API using standard `multipart/form-data` with `metadata.json`, module bindings, and secret bindings.
- **MTProxy Crypto Engine**: Implements the 64-byte client handshake parsing and streaming AES-256-CTR cipher.
- **Zero-Storage Security**: Cloudflare API tokens are held strictly in memory for the single deploy request.

### Telegram Data Centers Map:
- **DC1**: `149.154.175.50:443` (Miami)
- **DC2**: `149.154.167.51:443` (Amsterdam - Default European & Iranian traffic routing)
- **DC3**: `149.154.175.100:443` (Miami)
- **DC4**: `149.154.167.91:443` (Amsterdam)
- **DC5**: `91.108.56.165:443` (Singapore)

### Local Development
```bash
npm install
npm run dev
```

Build for production:
```bash
npm run build
npm start
```
