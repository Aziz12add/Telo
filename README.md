# Telo — Telegram Official WEB Proxy v1 Deployer on Cloudflare Workers

Telo is an automated deployer and production runtime for the official **Telegram WEB Proxy v1** on **Cloudflare Workers**.

---

## 🇮🇷 راهنمای فارسی (Persian Documentation)

### Telo چیست؟
تلو (Telo) یک استقراردهنده خودکار و ران‌تایم رسمی برای **Telegram WEB Proxy v1** بر روی بسترهای سرورلس **Cloudflare Workers** است. این پروژه بر اساس پروتکل باینری اختصاصی تلگرام (بیگ‌اندین، فریم‌های باینری، هندشیک قابلیت بریج با HMAC-SHA256، و ارتباط سوکت مستقیم TCP به دیتاسنترهای رسمی تلگرام بر روی پورت 443 با Durable Objects) کار می‌کند.

### اتصال در تلگرام (تنها روش معتبر)
کاربران **تنها** از طریق نوع پروکسی **WEB Proxy** در تلگرام متصل می‌شوند (نه SOCKS5 و نه پورت‌های MTProto کلاسیک VPS):
- **لینک مستقیم تحت وب:**
  ```text
  https://t.me/webproxy?server=<hostname>&secret=<secret>
  ```
- **لینک درون‌برنامه‌ای تلگرام:**
  ```text
  tg://webproxy?server=<hostname>&secret=<secret>
  ```

> **نکته مهم:** پارامتر `hostname` صرفاً نام دامنه ورکر است (مثلاً `my-proxy.my-subdomain.workers.dev`) بدون پیشوند `https://` و بدون مسیر اضافی. کلاینت تلگرام روی پورت استاندارد **443** به این ورکر وصل می‌شود.

### نحوه تنظیم دستی در تلگرام
اگر نمی‌خواهید روی لینک کلیک کنید:
1. در برنامه تلگرام به مسیر زیر بروید:
   **Settings &rarr; Data and Storage &rarr; Proxy Settings &rarr; Add Proxy**
   (تنظیمات &rarr; داده‌ها و حافظه &rarr; تنظیمات پروکسی &rarr; افزودن پروکسی)
2. نوع پروکسی را حتماً روی **WEB Proxy** قرار دهید.
3. در کادر **Server**: نام دامنه ورکر (Hostname) را وارد کنید.
4. در کادر **Secret**: کلید سکرت ۳۲ کاراکتری هگزادسیمال را وارد کنید.
5. ذخیره کنید.

### مراحل ایجاد توکن API کلودفلر (طی ۳۰ ثانیه):
1. وارد داشبورد کلودفلر و بخش توکن‌ها شوید:
   [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. روی دکمه **Create Token** کلیک کنید.
3. قالب پیش‌فرض **Edit Cloudflare Workers** را انتخاب کنید.
4. دسترسی‌های زیر را تأیید نمایید:
   - `Account` &gt; `Workers Scripts` &gt; `Edit`
   - `Account` &gt; `Workers Subdomain` &gt; `Edit`
   - `Account` &gt; `Account Settings` &gt; `Read`
5. دکمه **Continue to summary** و سپس **Create Token** را زده و توکن را در پنل Telo وارد کنید.

### چک‌لیست استقرار (Deploy Flow):
1. اجرای برنامه و باز کردن پنل Telo
2. وارد کردن Cloudflare API Token و زدن دکمه **Verify**
3. انتخاب اکانت و زدن دکمه **Deploy to Cloudflare Workers**
4. پس از چند ثانیه، نام هاست و لینک‌های اتصال نمایش داده می‌شوند.

### محدودیت‌ها و نکات فنی:
- **سهمیه پلن رایگان:** پلن رایگان کلودفلر روزانه ۱۰۰,۰۰۰ درخواست به شما می‌دهد که برای چت و فایل‌های معمولی روزمره کافیست.
- **تماس‌های صوتی و تصویری:** تماس‌های تلگرام عمدتاً بر پایه UDP P2P هستند و ممکن است از پروکسی وب TCP عبور نکنند.
- **کنترل دسترسی:** دسترسی به ورکر با کلید Secret و اعتبارسنجی HMAC قفل شده است؛ هرگونه درخواست متفرقه یا فیلترچی یک صفحه خنثی (Decoy Page) دریافت می‌کند.

---

## 🇬🇧 English Documentation

### What is Telo?
Telo deploys an official **Telegram WEB Proxy v1** runtime to **Cloudflare Workers**. It implements:
- Big-Endian binary frame codec (`HELLO`, `WELCOME`, `OPEN`, `DATA`, `CLOSE`, `WINDOW`, `PING`, `PONG`).
- Stream multiplexing and backpressure control using Cloudflare **Durable Objects** (`ProxySessionDO`).
- Direct TCP socket tunneling to Telegram Official Data Centers (`149.154.175.50:443`, `149.154.167.51:443`, etc.) using `cloudflare:sockets`.
- Decoy page masking for requests lacking the valid HMAC bridge capability token.

### Connection Format
Telegram connects exclusively via the **WEB Proxy** protocol:
- **Web Link:**
  ```text
  https://t.me/webproxy?server=<hostname>&secret=<secret>
  ```
- **Deep Link:**
  ```text
  tg://webproxy?server=<hostname>&secret=<secret>
  ```

> `hostname` must be provided without `https://` and without any URL path (e.g. `telo-worker.subdomain.workers.dev`). Telegram connects directly over port **443**.

### In-App Telegram Configuration
1. Open Telegram: **Settings &rarr; Data and Storage &rarr; Proxy Settings &rarr; Add Proxy**.
2. Select **WEB Proxy**.
3. Enter your **Server** (Worker hostname) and **Secret** (32 hex characters).
4. Tap Save and Connect.

### Cloudflare API Token Permissions
Create a custom token or use the template at [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):
- `Account` &gt; `Workers Scripts` &gt; `Edit`
- `Account` &gt; `Workers Subdomain` &gt; `Edit`
- `Account` &gt; `Account Settings` &gt; `Read`

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Run dev server (Express backend + Vite frontend)
npm run dev

# 3. Build for production
npm run build

# 4. Start production server
npm run start
```

### Limitations & Cloudflare ToS
- Cloudflare Workers Free plan has a limit of 100,000 requests/day.
- Telegram voice and video calls use UDP peer-to-peer and will generally bypass web proxies.
- Do not use for automated bulk abusive traffic.
