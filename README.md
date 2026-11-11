# PFM.ai

Vietnamese-first personal finance mobile application built with Expo SDK 58, React Native, TypeScript, local SQLite/SQLCipher persistence, and an AI assistant proxy.

> **Status**: Active personal/portfolio project. Expo Go runs an unencrypted preview database; standalone/development native builds enable SQLCipher encryption and Google Drive backup.

## Tech Stack

- **Mobile (`@pfm/mobile`)**: Expo SDK 58, React Native 0.88, Expo Router, React Native Paper, Zustand, React Hook Form, Expo SQLite (`useSQLCipher`), `@expo/ui/swift-ui`, `expo-glass-effect`, `expo-symbols`, `expo-notifications`, `expo-image-picker`.
- **Shared Packages**: Pure TypeScript business rules (`@pfm/domain`) and shared Zod/contract types (`@pfm/contracts`).
- **AI Proxy (`@pfm/proxy`)**: Node.js 24, Fastify, Zod.

## Structure

- `apps/mobile/src`: main Expo application source (screens, feature modules, native iOS/Android/web UI controls, SQLite queries/migrations, state, i18n messages).
- `packages/domain/src`: pure TypeScript domain calculations and validation rules.
- `packages/contracts/src`: shared request/response schemas and types.
- `services/proxy`: Fastify proxy service for AI chat, receipt extraction, and AI budget setup.
- `spikes/expo-go`: preserved early technical prototype (outside the pnpm workspace).
- `plan.md`: product requirements and owner-approved exceptions.
- `docs/`: progress notes, design specs, and manual device test checklists.

## Prerequisites & Install

Requires **Node.js 24** and **pnpm 10.33.4**. From the project root:

```powershell
Set-Location -LiteralPath 'C:\Users\Silentboiz\Desktop\Working\PFM.ai'
npx.cmd --yes pnpm@10.33.4 install
```

Do not run `npm install` inside individual workspace packages because `workspace:*` links require pnpm workspace resolution.

## Running the App

### 1. Expo Go Preview

```powershell
npx.cmd --yes pnpm@10.33.4 start
```

Sign in to the same Expo account on the CLI and device (or ensure devices are on the same reachable network). Note that Expo Go uses a separate unencrypted preview database and disables Google Drive sign-in and native SQLCipher encryption.

### 2. Native Development Client (SQLCipher + Google Drive Backup)

```powershell
# Android
npx.cmd --yes pnpm@10.33.4 --filter @pfm/mobile android

# iOS
npx.cmd --yes pnpm@10.33.4 --filter @pfm/mobile ios
```

### 3. AI Proxy Service (Optional, for AI Chat / Receipt Scan / AI Budget Setup)

```powershell
npx.cmd --yes pnpm@10.33.4 --filter @pfm/proxy start
```

Reads optional environment configuration from `.env.9router.local` at the repository root.

## Implemented Features

- **Overview & Statistics (`Tổng quan`, `Ngân sách → Thống kê`)**: Monthly income/expense/net summary, active wallet totals, parent-category spending breakdown, six-month trend charts with accessible text equivalents, and dismissible current-month budget alert banners.
- **Wallets & Categories (`Quản lý ví`, `Quản lý danh mục`)**: Active and archived wallets, two-level category tree ordered by parent with icons (`MaterialCommunityIcons` + iOS `SF Symbols`) and color swatches, plus safe category archival/reassignment.
- **Transactions & Search (`Giao dịch`)**: Income/expense/transfer CRUD with undo support, accent-insensitive Vietnamese search (`note_search`), multi-criteria filters (date range, kind, wallet, parent/child category, amount), and explicit apply/reset.
- **Budgets, Goals, Recurring & Debts (`Ngân sách`, `Mục tiêu tiết kiệm`, `Giao dịch định kỳ`, `Vay và cho vay`)**:
  - Monthly and custom-period budgets with warning/limit alerts and local notifications.
  - Savings goals tracked via a linked wallet balance or manual amount, with optional deadline monthly targets.
  - Recurring transaction rules with pause/resume and catch-up generation on open/resume (up to 366 occurrences per run).
  - Borrowed/lent debt principal and repayment tracking with overpayment checks, undo recalculation, and due-date reminders.
- **AI Assistant & Quick Entry (`Trợ lý AI`, `+` quick action menu)**: Natural-language Vietnamese transaction parsing, camera/library receipt scanning with confirmation review, AI-assisted budget setup, and local finance Q&A/advice.
- **Native iOS & Cross-Platform Input UX**:
  - Native SwiftUI `Menu` + inline `Picker` (`AppleMenuPicker`), graphical `DatePicker` sheet (`DateField`), dual-wheel `MonthField`, `hourAndMinute` `TimeField`, and segmented `Picker` on iOS, with tailored React Native Paper / Modal controls on Android and web.
  - Custom `FloatingTabBar` with iOS 26+ Liquid Glass (`expo-glass-effect`) and translucent fallback elsewhere.
  - Sticky bottom save bars on long forms (auto-hiding the tab bar while mounted), inline field validation feedback, and unsaved-changes confirmation guards on back/tab/close actions.
- **Settings, Localization & Security (`Cài đặt`)**: Vietnamese/English UI toggle, VND/USD display conversion, daily/budget/debt/recurring notification schedules with custom `HH:MM` time selection, optional PIN lock, SQLCipher encryption on native builds, and Google Drive JSON backup/restore.

## Checks

```powershell
# Lint, workspace typecheck, and Vitest unit tests
npx.cmd --yes pnpm@10.33.4 check

# Formatting check
npx.cmd --yes pnpm@10.33.4 format:check
```

Individual workspace checks:

```powershell
npx.cmd --yes pnpm@10.33.4 lint
npx.cmd --yes pnpm@10.33.4 -r typecheck
npx.cmd --yes pnpm@10.33.4 test
```

Device testing checklists live under `docs/testing/` (including `docs/testing/phase-1-expo-go.md`, `docs/testing/native-encryption.md`, and feature-specific `T2.*`, `T3.*`, `T4`, `T5` guides).

## Google Drive Backup Setup (Development & Standalone Builds)

Google Sign-In and Google Drive backup (`drive.file` scope) require a native development or standalone build (`expo run:android`, `expo run:ios`, or EAS Build); they do not run inside Expo Go.

1. **Google Cloud Project & Drive API**:
   - Create a project in Google Cloud Console and enable the **Google Drive API**.
2. **OAuth Consent Screen**:
   - Configure the OAuth Consent Screen and add the non-sensitive scope `https://www.googleapis.com/auth/drive.file` (allows PFM.ai to access only the `PFM.ai/pfm-backup-v1.json` file created by the app).
   - **Important**: Publish the OAuth Consent Screen to **"In production"** (for personal/internal use with `drive.file`, Google does not require paid security assessment, whereas leaving it in **"Testing"** causes refresh tokens to expire every 7 days).
3. **OAuth 2.0 Client IDs**:
   - **Web Client ID**: Create an OAuth 2.0 Client ID of type **Web application** and set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` in `apps/mobile/.env`.
   - **Android Client ID**: Create an OAuth 2.0 Client ID of type **Android** with package name `com.pfmai.app` and your signing certificate's SHA-1 fingerprint:
     - Debug keystore SHA-1: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`
     - EAS build SHA-1: `eas credentials -p android`
   - **iOS Client ID**: Create an OAuth 2.0 Client ID of type **iOS** with bundle identifier `com.pfmai.app`. Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` in `apps/mobile/.env` and replace `iosUrlScheme` in `apps/mobile/app.json` with the reversed client ID (`com.googleusercontent.apps.<IOS_CLIENT_ID_PREFIX>`).
4. **Build & Run Development Client**:
   - Android: `npx.cmd --yes pnpm@10.33.4 --filter @pfm/mobile android`
   - iOS: `npx.cmd --yes pnpm@10.33.4 --filter @pfm/mobile ios`

### Manual Device Testing Checklist (Google Drive Backup)

- [ ] First-time Google sign-in from `Cài đặt → Sao lưu Google Drive` creates `PFM.ai/pfm-backup-v1.json` on Drive.
- [ ] Closing and reopening the app keeps the Google session without re-prompting for sign-in.
- [ ] Creating/editing a transaction, wallet, budget, debt, or goal updates the backup file on Drive automatically.
- [ ] Turning off network connectivity during a change shows a network warning and automatically uploads once connectivity returns.
- [ ] Simulating full Drive storage (`storageQuotaExceeded`) pauses automatic retries and displays the quota message.
- [ ] Deleting `pfm-backup-v1.json` directly on Google Drive and tapping `Sao lưu ngay` recreates the file cleanly.
- [ ] Revoking PFM.ai access in Google Account settings transitions to `needs_reauth`, stops background retries, and prompts `Đăng nhập lại Google`.
- [ ] Uninstalling and reinstalling the app, then choosing `Khôi phục từ Google Drive` on the Onboarding screen restores all wallets, transactions, debts, budgets, goals, and recurring rules without asking for a starting balance.
- [ ] Restoring from one device to another (including Android ↔ iOS) preserves all balances and accent-insensitive note search.

## Preview Limitations

- Expo Go keeps its separate, unencrypted preview database, deferred PIN controls, and disabled Google Drive sign-in (`Chỉ có ở bản cài đặt riêng`).
- Standalone installations require SQLCipher and use a fresh encrypted database with a random 256-bit key in device-only secure storage. They do not import or delete preview data. First launch presents onboarding (with optional restore from Google Drive) without sample transactions; subsequent updates retain data. PIN is optional and independent of encryption.
- Rebuild the native app when native modules change (e.g., SQLCipher or `@react-native-google-signin/google-signin`); a JavaScript-only update is insufficient.
- In standalone/development builds, optional **Google Drive Backup** saves a logical JSON snapshot (`PFM.ai/pfm-backup-v1.json`) to the user's own Google Drive. **Privacy note**: while on-device SQLite storage is encrypted with SQLCipher, the backup file stored on Google Drive is **unencrypted JSON** (and includes transaction notes and borrower/lender names).
- Face ID and encryption-key recovery without a backup remain unimplemented: **losing the device or encryption key without an up-to-date Google Drive backup makes on-device data unrecoverable**. See `docs/testing/native-encryption.md` for checks.
