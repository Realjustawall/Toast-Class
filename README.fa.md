<div align="center">

<img src="docs/screenshots/toaster-banner.svg" alt="TOASTER Classroom Banner" width="100%" />

<br />

[![TOASTER checks](https://github.com/Realjustawall/Toast-Class/actions/workflows/checks.yml/badge.svg)](https://github.com/Realjustawall/Toast-Class/actions/workflows/checks.yml)
[![TOASTER native MySQL](https://github.com/Realjustawall/Toast-Class/actions/workflows/mysql.yml/badge.svg)](https://github.com/Realjustawall/Toast-Class/actions/workflows/mysql.yml)
[![TOASTER isolated document conversion](https://github.com/Realjustawall/Toast-Class/actions/workflows/conversion.yml/badge.svg)](https://github.com/Realjustawall/Toast-Class/actions/workflows/conversion.yml)
[![Production installer](https://github.com/Realjustawall/Toast-Class/actions/workflows/installer.yml/badge.svg)](https://github.com/Realjustawall/Toast-Class/actions/workflows/installer.yml)

![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![MySQL 8.4](https://img.shields.io/badge/MySQL-8.4-4479A1?logo=mysql&logoColor=white)
![LiveKit](https://img.shields.io/badge/Media-LiveKit-6366F1)
![Playwright E2E](https://img.shields.io/badge/E2E-Playwright-2EAD33?logo=playwright&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-blue)

**[English](README.md) | [فارسی](README.fa.md)**

[قابلیت‌ها](#قابلیتهای-کلیدی) • [تصاویر پیش‌نمایش](#تصاویر-پیشنمایش-فارسی-و-انگلیسی) • [نصب روی سرور](#راهنمای-نصب-و-راهاندازی-روی-سرور-لینوکس) • [محیط توسعه](#راهاندازی-محیط-توسعه-development) • [تست‌ها](#اجرای-تستها-و-بررسی-کیفیت-کد) • [امنیت](#نکات-امنیتی-و-لایسنس)

</div>

---

سامانهٔ جامع و خودمیزبان (Self-Hosted) کلاس آنلاین با پشتیبانی کامل از زبان **فارسی (راست‌به‌چپ)** و **انگلیسی (چپ‌به‌چپ)**، مجهز به دیتابیس **MySQL**، صوت و تصویر **LiveKit**، تخته هوشمند و حاشیه‌نویسی **PDF**، **تخته تعاملی ایزوله HTML/CSS/JS**، **GeoGebra**، یادداشت اشتراکی، چت عمومی و خصوصی با مدیریت دسترسی، و اسکن امنیتی فایل‌های آپلودی.

---

## تصاویر پیش‌نمایش (فارسی و انگلیسی)

| بخش / قابلیت                     |                                       نسخهٔ فارسی (RTL)                                       |                           نسخهٔ انگلیسی (LTR)                            |
| :------------------------------- | :-------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------: |
| **میزکار و مدیریت کلاس‌ها**      |                 ![پیش‌نمایش فارسی میزکار](docs/screenshots/workspace-fa.png)                  |      ![پیش‌نمایش انگلیسی میزکار](docs/screenshots/workspace-en.png)      |
| **فضای کلاس و مدیا**             |               ![پیش‌نمایش فارسی کلاس](docs/screenshots/classroom-media-fa.png)                | ![پیش‌نمایش انگلیسی کلاس](docs/screenshots/classroom-layout-desktop.png) |
| **تخته و قلم حساس به فشار**      |       ![پیش‌نمایش فارسی تخته](docs/screenshots/pressure-pen-desktop-fa-2026-11-11.png)        |    ![پیش‌نمایش انگلیسی تخته](docs/screenshots/teaching-board-en.png)     |
| **مدیریت فایل و کنترل دانلود**   | ![پیش‌نمایش فارسی کنترل دانلود](docs/screenshots/download-controls-desktop-fa-2026-11-11.png) |       ![پیش‌نمایش انگلیسی فایل‌ها](docs/screenshots/files-en.png)        |
| **اتاق‌های گروهی و نسخه موبایل** |              ![پیش‌نمایش فارسی موبایل](docs/screenshots/breakouts-mobile-fa.png)              |  ![پیش‌نمایش انگلیسی اتاق‌های گروهی](docs/screenshots/breakouts-en.png)  |

---

## قابلیت‌های کلیدی

- **صوت، تصویر و کنترل دسترسی زنده:** مبتنی بر سرور LiveKit با کنترل لحظه‌ای میکروفون، دوربین، اشتراک صفحه، واگذاری نقش ارائه‌دهنده (Presenter) و قفل‌های سمت سرور.
- **تخته هوشمند و حاشیه‌نویسی PDF:** قلم معمولی و حساس به فشار، تخته‌های چندصفحه‌ای، ورود و خروجی PDF همراه با حاشیه‌نویسی، تاریخچه و بازیابی نسخه‌های تخته، و کنترل دانلود برای هر فایل.
- **تخته تعاملی ایزوله HTML / CSS / JS:** امکان آپلود فایل `.html` یا بستهٔ `.zip` برای ساخت تخته تعاملی جداگانه (مشابه GeoGebra) با اجرای کاملاً ایزوله در `iframe` بدون دسترسی به DOM والد، کوکی، `localStorage` یا شبکه، همراه با اعتبارسنجی دقیق سمت سرور.
- **GeoGebra خودمیزبان:** اجرا روی دامنهٔ ایزوله (`math.class.example.com`) با فایل‌های آفلاین و تاییدشده با هش امنیتی.
- **چت عمومی و خصوصی:** کلیدهای مجزای مدیریت برای هر بخش، تاریخچه ماندگار، ویرایش و حذف پیام، شمارنده پیام‌های خوانده‌نشده و کنترل ارسال تصویر توسط دانشجویان.
- **ابزارهای آموزشی کامل:** یادداشت اشتراکی، نظرسنجی زنده، صف بالابردن دست، تایمر کلاس، حضور و غیاب، اتاق‌های گروهی (Breakout Rooms) و پنل مدیریت پلتفرم.
- **رابط دوزبانه و واکنش‌گرا:** طراحی بهینه برای دسکتاپ و موبایل با ۴ چیدمان آماده (`classic-bbb`، `immersive-glass`، `modular-skyroom`، `studio-hybrid`).

---

## راهنمای نصب و راه‌اندازی روی سرور (لینوکس)

> [!IMPORTANT]
> **پیش‌نیازهای سرور و دامنه**
>
> - سرور لینوکس با **Node.js نسخه ۲۴ به بالا**، **Docker Engine** و **Docker Compose 2.24+**
> - تنظیم دو رکورد DNS از نوع `A` به IP عمومی سرور:
>   - `class.example.com` (دامنهٔ اصلی کلاس)
>   - `math.class.example.com` (دامنهٔ ایزوله GeoGebra و تخته‌های تعاملی)
> - باز کردن پورت‌های مورد نیاز طبق [راهنمای نصب (INSTALL.md)](docs/INSTALL.md)

### ۱. دریافت سورس و اجرای نصب‌کننده

```sh
git clone https://github.com/Realjustawall/Toast-Class.git /opt/toaster/source
cd /opt/toaster/source
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com
```

> [!TIP]
> اگر گزینه‌ها را وارد نکنید، نصب‌کننده به صورت تعاملی از شما سوال می‌پرسد.  
> اسکریپت نصب به صورت خودکار رمزهای دیتابیس و LiveKit را می‌سازد، کاربر مدیر اولیه را ایجاد می‌کند، آنتی‌ویروس آپلود (ClamAV) را راه‌اندازی می‌کند و گواهی HTTPS خودکار را با Caddy فعال می‌سازد. ثبت‌نام عمومی در ابتدا بسته است و رمز عبور باید بین ۶ تا ۱۲۸ کاراکتر باشد (می‌توانید از `--password-file` یا رمز تصادفی تولیدشده استفاده کنید).

### ۲. فعال‌سازی تبدیل اسناد آفیس (اختیاری)

برای تبدیل فایل‌های Word/PowerPoint به PDF در محیط ایزوله، فلگ `--documents` را اضافه کنید:

```sh
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com --documents
```

### ۳. اجرا و عیب‌یابی سرویس

هنگام راه‌اندازی مجدد یا آپدیت، رمزها و دیتابیس قبلی حفظ می‌شوند:

```sh
sh install.sh start --directory /opt/toaster/instance
sh install.sh doctor --directory /opt/toaster/instance
```

جزئیات کامل دربارهٔ دامنه‌ها، Redis، بکاپ‌گیری و به‌روزرسانی در [docs/INSTALL.md](docs/INSTALL.md) آمده است.

---

## راه‌اندازی محیط توسعه (Development)

### ۱. نصب پکیج‌ها و تنظیم متغیرهای محیطی

```sh
git clone https://github.com/Realjustawall/Toast-Class.git
cd Toast-Class
npm ci
cp .env.example .env
```

فایل `.env` را مطابق اطلاعات دیتابیس (MySQL یا PostgreSQL)، دامنه (`APP_ORIGIN`) و کلیدهای LiveKit خود تنظیم کنید.

### ۲. اجرای مایگریشن دیتابیس و سرور توسعه

```sh
# برای PostgreSQL:
npm run migrate

# یا برای MySQL:
npm run migrate:mysql

# اجرای هم‌زمان API و فرانت‌اند Vite:
npm run dev
```

<details>
<summary>اختیاری: اعطای دسترسی مدیر پلتفرم</summary>

```sh
npm run admin:grant -- user@example.com
```

</details>

---

## اجرای تست‌ها و بررسی کیفیت کد

<details>
<summary>اجرای کامل تست‌های واحد، E2E و ممیزی امنیتی</summary>

```sh
npm run typecheck
npm run format:check
npm run build:server
npm test
npm run build
npm audit --audit-level=high
npx playwright install chromium
npm run test:e2e
```

برای اجرای تست‌ها با دیتابیس **MySQL**:

```sh
TEST_DATABASE_ENGINE=mysql TEST_MYSQL_ADMIN_URL="mysql://root:password@127.0.0.1:3306/toaster_admin_test" npm test
```

> [!NOTE]
> مقدار `TEST_MYSQL_ADMIN_URL` باید به یک دیتابیس اختصاصی با پسوند `_test` اشاره کند تا هر تست دیتابیس ایزوله خود را بسازد و پاک کند.

</details>

---

## ساخت بستهٔ سورس کم‌حجم (Release)

برای تهیهٔ فایل ZIP سورس همراه با هش SHA-256 (بدون `node_modules`، فایل‌های بیلد و اطلاعات محرمانه):

```sh
node scripts/pack-release.mjs
```

---

## نکات امنیتی و لایسنس

> [!WARNING]
> برابری کامل با BigBlueButton یا PDF Annotator و ظرفیت ۸۰۰ کاربر هم‌زمان رسانه‌ای تایید نشده است. پیش از استفاده در محیط تولید حتماً [docs/SECURITY.md](docs/SECURITY.md) را مطالعه کنید.

کد اصلی پروژه تحت مجوز [MIT](LICENSE) منتشر شده است و شرایط لایسنس ابزارهای جانبی (از جمله GeoGebra در استفادهٔ تجاری) در [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) درج شده است.
