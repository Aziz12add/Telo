# Telo — Telegram Official WEB Proxy v1 on Cloudflare Workers

Telo is a canonical, production-grade implementation of the official **Telegram WEB Proxy v1** (`tproxy-server`) protocol for **Cloudflare Workers** with Durable Objects.

---

## 📁 ساختار مخزن (Project Structure)

```text
Telo/
├── src/
│   ├── index.ts           # ورودی اصلی ورکر، روتینگ، اعتبارسنجی بریج و توکن نشست
│   ├── WebSocketProxy.ts  # کلاس Durable Object (ProxySessionDO / WebSocketProxy) و تونل سوکت تلگرام
│   └── protocol.ts        # کدک فریم‌های باینری بیگ‌اندین تلگرام و توابع رمزنگاری HMAC-SHA256
├── wrangler.toml          # کانفیگ رسمی ورکر، بایندینگ DO و مایگریشن SQLite
├── package.json           # وابستگی‌ها و اسکریپت‌های ساخت
├── tsconfig.json          # پیکربندی تایپ‌اسکریپت Cloudflare Workers
├── .gitignore             # نادیده‌گیری فایل‌های ساخت و وابستگی‌ها
└── README.md              # مستندات و راهنمای اتصال
```

---

## 🇮🇷 راهنمای استفاده و اتصال

### پروتکل Telegram WEB Proxy v1 چیست؟
تلگرام دسکتاپ و نسخه‌های رسمی موبایل، علاوه بر پروتکل‌های قدیمی، از پروتکل مدرن **WEB Proxy v1** برای عبور از فیلترینگ استفاده می‌کنند. این پروتکل بر بستر WebSocket و فریم‌های باینری بیگ‌اندین کار می‌کند:
- **فریم‌های پشتیبانی‌شده:** `OPEN (0x01)`, `DATA (0x02)`, `CLOSE (0x03)`, `WINDOW (0x04)`, `PING (0x05)`, `PONG (0x06)`, `HELLO (0x10)`, `WELCOME (0x11)`, `BYE (0x1f)`
- **ساختار هدر فریم:** 8 بایت `[type: u8][stream_id: u24 BE][length: u32 BE][payload]`
- **کنترل جریان و جریان‌های چندگانه:** پنجره 4MiB با سقف 32 استریم همزمان در هر اتصال
- **اعتبارسنجی قابلیت Bridge:** الگوریتم HMAC-SHA256 بر روی `tdesktop-web-proxy-bridge-v1\n<canonical-hostname>`

### نحوه اتصال در تلگرام
کاربران از طریق نوع پروکسی **WEB Proxy** در تلگرام متصل می‌شوند:

- **لینک مستقیم تحت وب:**
  ```text
  https://t.me/webproxy?server=<hostname>&secret=<secret>
  ```

- **لینک درون‌برنامه‌ای تلگرام (دیپ‌لینک):**
  ```text
  tg://webproxy?server=<hostname>&secret=<secret>
  ```

> **نکته:** `hostname` نام دامنه ورکر است (مثلاً `proxy.yoursubdomain.workers.dev`) بدون `https://` و پورت پیش‌فرض **443** است. `secret` یک کلید هگز ۳۲ رقمی (۱۶ بایت) است.

### تنظیم دستی در تلگرام:
1. در برنامه تلگرام به مسیر زیر بروید:
   **Settings &rarr; Data and Storage &rarr; Proxy Settings &rarr; Add Proxy**
2. نوع پروکسی را بر روی **WEB Proxy** تنظیم کنید.
3. در کادر **Server**: نام دامنه ورکر (`hostname`) را وارد کنید.
4. در کادر **Secret**: کلید ۳۲ رقمی هگزادسیمال را وارد کنید.

---

## 🇬🇧 Deployment & Development

### 1. Requirements
- Node.js >= 18
- Cloudflare Wrangler CLI (`npm install -g wrangler`)

### 2. Setup & Secrets
```bash
# کلید سکرت را روی ورکر ثبت کنید
wrangler secret put PROXY_SECRET
# کلید ۳۲ هگز را وارد کنید، مانند: 000102030405060708090a0b0c0d0e0f
```

### 3. Deploy
```bash
wrangler deploy
```

---

## 🛡️ امنیت و ضد فیلترینگ (Decoy & Anti-Censorship)
- تمامی درخواست‌های غیرمجاز یا اسکنرهای شبکه به صفحه خطای خنثی (`404 Not Found`) هدایت می‌شوند.
- دسترسی به ورکر با کلید سکرت و هش HMAC تایید می‌شود.
- اتصال مستقیم TCP با استفاده از `cloudflare:sockets` به آی‌پی‌های رسمی دیتاسنترهای تلگرام برقرار می‌شود.
