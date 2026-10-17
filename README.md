# Telo – Telegram WEB proxy relay on Cloudflare Workers

**English** | [فارسی](#fa)

Telo is a study project: a server-side implementation of Telegram's experimental **WEB proxy** (protocol v1) that runs on **Cloudflare Workers + Durable Objects**. A Telegram client that supports the WEB proxy type can connect to it, and Telo relays the client's traffic to Telegram's datacenters.

> **Status: experimental.** The WEB proxy is itself a proof of concept
> ([`telegramdesktop/tproxy-server`](https://github.com/telegramdesktop/tproxy-server)); the protocol and client support may change. Telo has been verified to connect with a real Telegram client, but it is not production-hardened.

## How it works

```
Telegram app ──(MTProxy-obfuscated bytes, framed)──▶ bridge page in the app's WebView
                                                       │  HTTPS + one WebSocket
                                                       ▼
                                             Cloudflare Worker (index.ts)
                                                       │  per-session Durable Object
                                                       ▼
                                      WebSocketProxy (frames ⇄ streams ⇄ MTProxy transcoder)
                                                       │  plain TCP (cloudflare:sockets)
                                                       ▼
                                                Telegram datacenter
```

1. The app opens `https://<host>/?bridge=<capability>`. The capability is `base64url(HMAC-SHA256(secret, "tdesktop-web-proxy-bridge-v1\n" + hostname))`; without it the Worker serves a plain public page / 404.
2. The Worker returns a small **bridge page** (strict CSP) that talks to the app through the injected `TelegramWebProxy` object.
3. The bridge sends the app's `HELLO` frame to `POST /api/v1/session` (authorised by a two-minute bootstrap token) and gets a `WELCOME` frame plus a session token.
4. The bridge opens **one multiplexed WebSocket** (`/api/v1/ws`, subprotocol `tproxy-v1.<token>`) handled by a per-session Durable Object.
5. Inside the session, each `OPEN` starts a logical stream. The first 64 bytes of a stream are an MTProxy *obfuscated2* init packet; the relay decrypts it with the secret to learn the target DC, opens a TCP connection to that DC, and **transcodes** the traffic between the secret-keyed cipher (client side) and a plain obfuscated2 connection (DC side).
6. Flow control follows the spec: 4 MiB of credit per stream and direction, `WINDOW` returned only after bytes reached the DC socket.

The secret is never sent to the Worker's clients as such: a wrong secret fails to decrypt the init packet, so unauthenticated traffic never causes an outbound connection.

## Repository layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: public site, bridge page, session creation/deletion, WebSocket routing |
| `src/WebSocketProxy.ts` | Durable Object: one relay session, stream management, flow control, DC sockets |
| `src/protocol.ts` | WEB proxy v1 frame codec, bridge capability, secret decoding |
| `src/obfuscated2.ts` | MTProxy obfuscated2 helpers (streaming AES-256-CTR on WebCrypto) |
| `src/tokens.ts` | Stateless bootstrap/session tokens derived from the secret |
| `src/bridge.ts` | The bridge page (HTML/JS) served to the app's WebView |
| `src/dc.ts` | Telegram DC address table |
| `LICENSE` | MIT license |
| `wrangler.toml` | Worker + Durable Object configuration |

## Requirements

- A Cloudflare account (Workers and Durable Objects; the SQLite-backed Durable Object class is available on the free plan)
- Node.js (current LTS) and npm
- A Telegram client that supports the WEB proxy type. Support is recent and experimental; reports mention Telegram Desktop 7.1+ and recent Android builds. Check your app's proxy settings.

## Setup

```bash
git clone https://github.com/Aziz12add/Telo.git
cd Telo
npm install
npx tsc --noEmit        # type-check

# generate a secret: 32 hex characters (optionally prefixed with "dd")
openssl rand -hex 16

npx wrangler secret put PROXY_SECRET      # paste the secret
npx wrangler deploy
```

`wrangler.toml` essentials:

```toml
name = "telo-telegram-proxy"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[durable_objects.bindings]]
name = "WEBSOCKET_PROXY"
class_name = "WebSocketProxy"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["WebSocketProxy"]
```

Using your own domain (a Cloudflare custom domain) is recommended over `workers.dev`: the bridge capability is derived from the hostname, and the app is configured with that hostname.

## Connecting a client

Add a WEB proxy in the Telegram app with:

- **server:** your hostname, without scheme or port (e.g. `proxy.example.com`)
- **secret:** the value you stored in `PROXY_SECRET`

As a link: `https://t.me/webproxy?server=<hostname>&secret=<secret>` (format as used by current clients; verify against your app version).

Watch what happens while connecting:

```bash
npx wrangler tail --format pretty
```

A healthy connection logs `bridge page served` → `session created` → `ws: forwarding to session DO` → `attached` → one `stream N connected` per stream.

## Security notes

- Treat `PROXY_SECRET` like a password. The `?bridge=<capability>` URL is derived from it and appears in request logs (`wrangler tail`, dashboard logs); if it leaks, rotate the secret.
- Replace the placeholder public page in `index.ts` (`PUBLIC_HOME`) with something real if you want unauthenticated visitors to see an ordinary site.
- Outbound connections are only made after a successful secret-keyed init packet and only to the five hard-coded Telegram DCs.
- Keep logging modest: observability records every request.
- Check Cloudflare's terms of service for your use case and comply with the laws that apply to you.

## Known limitations

- **No voice/video calls.** Calls use UDP for media; the WEB proxy carries TCP streams only, and Cloudflare Workers has no outbound UDP. Calls may ring (signalling goes through the proxy) but media will not be relayed. Use a SOCKS5 proxy with UDP support or a VPN for calls.
- **Latency.** Traffic crosses several hops (client → Cloudflare edge → Durable Object → DC). The displayed proxy "ping" can include session setup. The Durable Object is placed near the first request; a `locationHint` can be tried to move it closer to the DCs.
- **Single multiplexed WebSocket per session.** A session that loses its WebSocket is closed, not resumed.
- **No liveness probing.** Workers cannot send WebSocket protocol pings, and the relay does not emit frame-level `PING`, so half-dead connections are only detected when the socket closes.
- **Memory.** A Durable Object has roughly 128 MB; the worst case (32 streams × 4 MiB credit) can approach that.
- **Static DC addresses.** The IPs in `src/dc.ts` are defaults and may change.
- **Bridge page is minimal.** It implements only the `websocket` carrier and the `TelegramWebProxy` boundary, and was tested against one client setup.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App reloads the bridge every ~2 s, logs show `non-binary message` | Binary WebSocket messages arrive as `Blob`/non-`ArrayBuffer` with newer compatibility dates. The relay sets `binaryType = 'arraybuffer'` and converts defensively; make sure the latest `WebSocketProxy.ts` is deployed. |
| `bridge page served` never appears | Wrong hostname or secret in the client, or the capability does not match the hostname. |
| `session: bootstrap invalid/expired` | The page was open longer than two minutes, or the clock/secret differs. |
| `init rejected` | The secret in the app differs from `PROXY_SECRET`. |
| `connect to dc … failed` | The DC address is unreachable from the Durable Object's location; check `src/dc.ts`. |
| `Network connection lost` in `tail` | The client closed the WebSocket abruptly; usually harmless. |

## Development

```bash
npx tsc --noEmit      # type-check
npx wrangler dev      # local run (needs a real HTTPS hostname and client to exercise end to end)
```

## References

- Telegram Desktop WEB proxy reference relay and protocol notes: <https://github.com/telegramdesktop/tproxy-server> (`PROTOCOL.md`)
- MTProto transports (obfuscation): <https://core.telegram.org/mtproto/mtproto-transports>
- Cloudflare Workers TCP sockets and Durable Objects documentation

## License

Released under the [MIT License](LICENSE). This project was written independently from the specifications above; if you reuse code from other implementations, follow their licences.

---

<a id="fa"></a>

<div dir="rtl" lang="fa">

# Telo – رله‌ی WEB proxy تلگرام روی Cloudflare Workers

[English](#telo--telegram-web-proxy-relay-on-cloudflare-workers) | **فارسی**

Telo یک پروژه‌ی مطالعاتی است: پیاده‌سازی سمت سرورِ **WEB proxy** آزمایشی تلگرام (نسخه‌ی ۱ پروتکل) که روی **Cloudflare Workers و Durable Objects** اجرا می‌شود. کلاینت تلگرامی که نوع WEB proxy را پشتیبانی کند می‌تواند به آن وصل شود و Telo ترافیک را به دیتاسنترهای تلگرام می‌رساند.

> **وضعیت: آزمایشی.** خود WEB proxy هم یک نمونه‌ی اثبات مفهوم (proof of concept) است
> ([`telegramdesktop/tproxy-server`](https://github.com/telegramdesktop/tproxy-server)) و پروتکل و پشتیبانی کلاینت‌ها ممکن است تغییر کند. اتصال Telo با کلاینت واقعی تلگرام تأیید شده است، اما برای محیط تولید (production) سخت‌سازی نشده.

## طرز کار

```
Telegram app ──(MTProxy-obfuscated bytes, framed)──▶ bridge page in the app's WebView
                                                       │  HTTPS + one WebSocket
                                                       ▼
                                             Cloudflare Worker (index.ts)
                                                       │  per-session Durable Object
                                                       ▼
                                      WebSocketProxy (frames ⇄ streams ⇄ MTProxy transcoder)
                                                       │  plain TCP (cloudflare:sockets)
                                                       ▼
                                                Telegram datacenter
```

۱. اپ آدرس `https://<host>/?bridge=<capability>` را باز می‌کند. مقدار capability برابر `base64url(HMAC-SHA256(secret, "tdesktop-web-proxy-bridge-v1\n" + hostname))` است. بدون آن، Worker فقط یک صفحه‌ی عمومی یا ۴۰۴ برمی‌گرداند.

۲. Worker یک **صفحه‌ی bridge** کوچک (با CSP سخت‌گیرانه) برمی‌گرداند که از طریق شیء `TelegramWebProxy` با اپ حرف می‌زند.

۳. bridge فریم `HELLO` اپ را به `POST /api/v1/session` می‌فرستد (با توکن bootstrap دو‌دقیقه‌ای) و یک فریم `WELCOME` و توکن session می‌گیرد.

۴. سپس **یک WebSocket چندگانه** (`/api/v1/ws` با subprotocol به شکل `tproxy-v1.<token>`) باز می‌کند که یک Durable Object مخصوص همان session آن را مدیریت می‌کند.

۵. داخل session، هر `OPEN` یک استریم منطقی می‌سازد. ۶۴ بایت اول هر استریم یک بسته‌ی init از نوع *obfuscated2* در MTProxy است. رله آن را با secret رمزگشایی می‌کند تا DC مقصد را بفهمد، یک اتصال TCP به آن DC باز می‌کند و ترافیک را بین رمز مبتنی بر secret (سمت کلاینت) و یک اتصال obfuscated2 ساده (سمت DC) **ترجمه** می‌کند.

۶. کنترل جریان مطابق مشخصات است: ۴ مگابایت credit برای هر استریم و هر جهت، و `WINDOW` فقط بعد از رسیدن بایت‌ها به سوکت DC برگردانده می‌شود.

secret با اتصال بی‌اعتبار هرگز باعث اتصال خروجی نمی‌شود: secret اشتباه init را درست رمزگشایی نمی‌کند، پس ترافیک احراز‌نشده هیچ اتصال خروجی نمی‌سازد.

## ساختار مخزن

| فایل | کاربرد |
|---|---|
| `src/index.ts` | ورودی Worker: سایت عمومی، صفحه‌ی bridge، ساخت و حذف session، مسیریابی WebSocket |
| `src/WebSocketProxy.ts` | Durable Object: یک session رله، مدیریت استریم‌ها، کنترل جریان، سوکت‌های DC |
| `src/protocol.ts` | کدک فریم‌های WEB proxy نسخه‌ی ۱، capability مربوط به bridge، دیکد کردن secret |
| `src/obfuscated2.ts` | توابع obfuscated2 در MTProxy (رمز AES-256-CTR جریانی روی WebCrypto) |
| `src/tokens.ts` | توکن‌های bootstrap و session بدون وضعیت (stateless) که از secret ساخته می‌شوند |
| `src/bridge.ts` | صفحه‌ی bridge (HTML/JS) که به WebView اپ داده می‌شود |
| `src/dc.ts` | جدول آدرس دیتاسنترهای تلگرام |
| `LICENSE` | لایسنس MIT |
| `wrangler.toml` | تنظیمات Worker و Durable Object |

## پیش‌نیازها

- حساب Cloudflare (Workers و Durable Objects؛ کلاس Durable Object مبتنی بر SQLite روی پلن رایگان در دسترس است)
- Node.js (نسخه‌ی LTS جدید) و npm
- کلاینت تلگرامی که نوع WEB proxy را پشتیبانی کند. این قابلیت جدید و آزمایشی است؛ گزارش‌ها از Telegram Desktop نسخه‌ی ۷.۱ به بالا و نسخه‌های جدید اندروید می‌گویند. تنظیمات پروکسی اپ خودت را بررسی کن.

## راه‌اندازی

```bash
git clone https://github.com/Aziz12add/Telo.git
cd Telo
npm install
npx tsc --noEmit        # type-check

# generate a secret: 32 hex characters (optionally prefixed with "dd")
openssl rand -hex 16

npx wrangler secret put PROXY_SECRET      # paste the secret
npx wrangler deploy
```

موارد مهم `wrangler.toml`:

```toml
name = "telo-telegram-proxy"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[durable_objects.bindings]]
name = "WEBSOCKET_PROXY"
class_name = "WebSocketProxy"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["WebSocketProxy"]
```

بهتر است به‌جای `workers.dev` از دامنه‌ی خودت (custom domain روی Cloudflare) استفاده کنی: capability از روی hostname ساخته می‌شود و اپ هم با همان hostname پیکربندی می‌شود.

## اتصال کلاینت

در اپ تلگرام یک WEB proxy با این مقادیر اضافه کن:

- **server:** hostname تو، بدون scheme و بدون پورت (مثلاً `proxy.example.com`)
- **secret:** همان مقداری که در `PROXY_SECRET` گذاشتی

به شکل لینک: `https://t.me/webproxy?server=<hostname>&secret=<secret>` (قالب مورد استفاده‌ی کلاینت‌های فعلی؛ با نسخه‌ی اپ خودت بررسی کن).

هنگام اتصال این را اجرا کن تا ببینی چه می‌شود:

```bash
npx wrangler tail --format pretty
```

یک اتصال سالم این‌ها را لاگ می‌کند: `bridge page served` ← `session created` ← `ws: forwarding to session DO` ← `attached` ← به‌ازای هر استریم یک `stream N connected`.

## نکات امنیتی

- `PROXY_SECRET` را مثل رمز عبور نگه‌دار. آدرس `?bridge=<capability>` از آن ساخته می‌شود و در لاگ درخواست‌ها (`wrangler tail` و داشبورد) دیده می‌شود؛ اگر لو رفت، secret را عوض کن.
- صفحه‌ی عمومی placeholder داخل `index.ts` (`PUBLIC_HOME`) را با چیزی واقعی عوض کن، اگر می‌خواهی بازدیدکننده‌ی بدون احراز هویت یک سایت معمولی ببیند.
- اتصال خروجی فقط بعد از یک بسته‌ی init معتبر (رمز‌شده با secret) و فقط به ۵ دیتاسنتر تلگرام که در کد ثابت شده‌اند ساخته می‌شود.
- لاگ‌گیری را محدود نگه‌دار: observability هر درخواست را ثبت می‌کند.
- شرایط استفاده‌ی Cloudflare را برای کاربرد خودت بررسی کن و قوانین قابل‌اعمال را رعایت کن.

## محدودیت‌های شناخته‌شده

- **تماس صوتی و تصویری پشتیبانی نمی‌شود.** مدیای تماس‌ها روی UDP است؛ WEB proxy فقط استریم‌های TCP را عبور می‌دهد و Cloudflare Workers هم UDP خروجی ندارد. ممکن است تماس زنگ بخورد (سیگنالینگ از پروکسی رد می‌شود) اما مدیا رله نمی‌شود. برای تماس از SOCKS5 با پشتیبانی UDP یا یک VPN استفاده کن.
- **تأخیر.** ترافیک از چند گام عبور می‌کند (کلاینت ← لبه‌ی Cloudflare ← Durable Object ← DC). «پینگ» نمایش‌داده‌شده برای پروکسی ممکن است راه‌اندازی session را هم شامل شود. Durable Object نزدیک اولین درخواست ساخته می‌شود؛ می‌توان با `locationHint` آن را نزدیک‌تر به DCها گذاشت.
- **یک WebSocket چندگانه برای هر session.** اگر WebSocket یک session قطع شود، آن session بسته می‌شود و ادامه پیدا نمی‌کند.
- **بدون بررسی زنده بودن اتصال.** Workers نمی‌تواند ping پروتکلی WebSocket بفرستد و رله هم فریم `PING` ارسال نمی‌کند؛ پس اتصال‌های نیمه‌مرده فقط وقتی سوکت بسته شود تشخیص داده می‌شوند.
- **حافظه.** یک Durable Object حدود ۱۲۸ مگابایت حافظه دارد؛ بدترین حالت (۳۲ استریم × ۴ مگابایت credit) می‌تواند به آن نزدیک شود.
- **آدرس‌های ثابت DC.** IPهای داخل `src/dc.ts` مقدار پیش‌فرض‌اند و ممکن است عوض شوند.
- **صفحه‌ی bridge حداقلی است.** فقط carrier از نوع `websocket` و مرز `TelegramWebProxy` را پیاده می‌کند و روی یک تنظیم مشخص کلاینت تست شده است.

## عیب‌یابی

| نشانه | علت محتمل |
|---|---|
| اپ هر حدود ۲ ثانیه bridge را دوباره بارگذاری می‌کند و در لاگ `non-binary message` می‌بینی | با تاریخ‌های سازگاری (compatibility date) جدیدتر، پیام‌های باینری WebSocket به‌جای `ArrayBuffer` به شکل `Blob` می‌رسند. رله `binaryType = 'arraybuffer'` را تنظیم می‌کند و دفاعی تبدیل هم می‌کند؛ مطمئن شو آخرین `WebSocketProxy.ts` دیپلوی شده است. |
| `bridge page served` هیچ‌وقت دیده نمی‌شود | hostname یا secret در کلاینت اشتباه است، یا capability با hostname نمی‌خواند. |
| `session: bootstrap invalid/expired` | صفحه بیش از دو دقیقه باز بوده، یا ساعت یا secret فرق دارد. |
| `init rejected` | secret داخل اپ با `PROXY_SECRET` فرق دارد. |
| `connect to dc … failed` | آدرس DC از محل Durable Object قابل دسترس نیست؛ `src/dc.ts` را بررسی کن. |
| `Network connection lost` در `tail` | کلاینت WebSocket را ناگهان بسته؛ معمولاً بی‌ضرر است. |

## توسعه

```bash
npx tsc --noEmit      # type-check
npx wrangler dev      # local run (needs a real HTTPS hostname and client to exercise end to end)
```

## منابع

- رله‌ی مرجع WEB proxy در Telegram Desktop و یادداشت‌های پروتکل: <https://github.com/telegramdesktop/tproxy-server> (فایل `PROTOCOL.md`)
- ترنسپورت‌های MTProto (obfuscation): <https://core.telegram.org/mtproto/mtproto-transports>
- مستندات Cloudflare Workers TCP sockets و Durable Objects

## لایسنس

منتشر‌شده تحت [لایسنس MIT](LICENSE). این پروژه مستقل از روی مشخصات بالا نوشته شده است؛ اگر از پیاده‌سازی‌های دیگر کدی استفاده کردی، شرایط لایسنس آن‌ها را رعایت کن.

</div>
