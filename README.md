# PFM.ai

Vietnamese personal-finance app. Current target: Expo Go preview through Phases
1–3. The application is under construction, not ready for real financial data.

## Structure

- `apps/mobile/src`: main Expo SDK 58 application source.
- `packages/domain/src`: pure TypeScript business rules.
- `packages/contracts/src`: shared validation/types.
- `spikes/expo-go`: preserved technical prototype; not part of the workspace.
- `plan.md`: product requirements and owner-approved exceptions.
- `docs/progress.md`: completed checks and outstanding work.

## Install from the project root

Node.js 24 and pnpm 10.33.4. If pnpm is not installed, use its pinned version
through npm without changing global tools:

```powershell
Set-Location -LiteralPath 'C:\Users\Silentboiz\Desktop\Working\PFM.ai'
npx.cmd --yes pnpm@10.33.4 install
```

This creates the workspace links and `pnpm-lock.yaml`. Do not run `npm install`
inside individual workspace packages: their `workspace:*` dependencies require
workspace-aware installation. Review and preserve the generated lockfile.

The owner selected React Native Paper, Zustand and React Hook Form for the
application, together with direct Expo SQLite. Install these SDK-compatible
app dependencies through Expo from the root after the workspace install:

```powershell
npx.cmd --yes pnpm@10.33.4 --filter @pfm/mobile exec expo install expo-sqlite react-native-paper zustand react-hook-form @expo/vector-icons --pnpm
```

`@expo/vector-icons` supplies icons for Paper. No provider keys are required.

## Main application

After installation, run from the root:

```powershell
npx.cmd --yes pnpm@10.33.4 start
```

This launches `apps/mobile` in Expo Go mode. Sign in to the same Expo account on
the CLI and iPhone when prompted. Keep devices on the same reachable network.
The main app now has Vietnamese navigation, optional initial cash balance,
SQLite persistence, wallet/category management, manual income/expense/transfer
create/edit/delete with undo, local disconnected chat, and typed confirmation
before deleting preview data. Monthly budgets and local alert integration are
implemented; goals, recurring entries, debt and remaining Phase 2 features are pending.

From the overview, choose `Quản lý ví` to manage wallets. Archived wallets remain
available under `Đã lưu trữ`; the overview total explicitly covers active wallets.

From `Cài đặt`, choose `Quản lý danh mục` for the two-level category tree. Create,
rename, choose an icon/color, or archive a category. Archiving a parent includes
its children; transaction reassignment requires explicit selection. Category
statistics will show parent totals only when the statistics feature is built.

From `Giao dịch`, add income/expense/transfers, edit, or confirm deletion. Undo
restores the most recent deletion until another successful write, tab change or
reload. Future dates show a warning from tomorrow but can still be saved. Dates
currently use YYYY-MM-DD text entry; manual transactions use Asia/Ho_Chi_Minh.
See [transaction device checks](docs/testing/T2.3-transactions.md).

Choose `Giao dịch → Tìm kiếm và lọc` to search notes without Vietnamese accents
and combine date, kind, wallet, category (including children) and amount filters.
Apply/reset is explicit. Schema version 2 adds/backfills derived note_search while
keeping original notes; existing snapshot/rollback safeguards remain in use.
See [search/upgrade device checks](docs/testing/T2.4-search.md).

From `Ngân sách`, set overall/category monthly limits, edit or pause them, and
switch months. Active current-month budgets that reach their warning threshold or
limit also surface a dismissible alert banner at the top of `Tổng quan`. Open
`Cài đặt → Thông báo → Ngân sách` to request permission or schedule a five-second
local test, then return to the phone home screen to observe it. Foreground OS
banners are suppressed for budget alerts; actual notifications can be seen in the
system notification list. expo-notifications 58.1.6 is included; no push
server/token is used. See [budget/device checks](docs/testing/T2.5-budgets.md).

Open Overview > Mục tiêu tiết kiệm to create/edit/archive/restore savings goals. Track
progress from a selected wallet's balance or a manually entered amount. A deadline
adds a rounded-up monthly saving amount; tracking does not move or reserve money.
See [goal/device checks](docs/testing/T2.6-goals.md).

Open Transactions > Giao dịch định kỳ to create/edit/pause/resume recurring rules.
Generation catches up on open/resume, up to 366 occurrence dates per run. Archived
references block until restored; explicit resume skips the paused period. Local
reminders target 09:00 Vietnam one day before due, replenished on app open/resume
in a finite window. See [recurring/device checks](docs/testing/T2.7-recurring.md).

Open Transactions > Vay và cho vay to record borrowed/lent principal and repayments.
Debt cash flows change wallet balances, not income/expense totals. Overpayments
are rejected, and deleting/undoing a payment recalculates outstanding/status.
Optional due-date reminders target 09:00 Vietnam the preceding day. See
[debt/device checks](docs/testing/T2.9-debts.md).

Overview includes month income/expense/net, parent-category spending, six-month
charts, budget amounts, current goals, recent selected-month transactions, and a
dismissible banner for active current-month budgets that reach their warning
threshold or limit. Charts include exact text equivalents. See
[dashboard/device checks](docs/testing/T2.8-dashboard.md).

Follow [the iPhone check list](docs/testing/phase-1-expo-go.md) to verify persistence,
dark mode, keyboard behavior and deletion on the device. Owner confirms main-app
wallet add/edit/save on iPhone SE 3; remaining device acceptance is pending.

The previous spike is still runnable independently from `spikes/expo-go` with
`npx.cmd expo start --go`. Stop one development server before starting the other
if both try to use the same port. Database files are not copied between them.

## Checks

```powershell
npx.cmd --yes pnpm@10.33.4 check
```

Runs lint, strict type checking and Vitest. `format:check` checks formatting.
These require installed workspace dependencies. A command being configured does
not mean its checks have run; actual results are in `docs/progress.md`.

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

## Preview limitations

Expo Go keeps its separate, unencrypted preview database, deferred PIN controls, and disabled Google Drive sign-in (`Chỉ có ở bản cài đặt riêng`).
Standalone installations now require SQLCipher and use a fresh encrypted database
with a random 256-bit key in device-only secure storage. They do not import or
delete preview data. First launch presents onboarding (with optional restore from Google Drive) without sample transactions;
subsequent updates retain data. PIN is optional and independent of encryption.

Rebuild the native app to include SQLCipher and `@react-native-google-signin/google-signin`; a JavaScript-only update is insufficient.
Native encryption and PIN performance still require iPhone acceptance.
In standalone/development builds, optional **Google Drive Backup** saves a logical JSON snapshot (`PFM.ai/pfm-backup-v1.json`) to the user's own Google Drive. **Note on privacy**: while on-device SQLite storage is encrypted with SQLCipher, the backup file stored on the user's Google Drive is **unencrypted JSON** (and includes transaction notes and borrower/lender names).
Face ID and encryption-key recovery without a backup remain unimplemented: **losing the device or encryption key without an up-to-date Google Drive backup makes on-device data unrecoverable**. See `docs/testing/native-encryption.md` for checks.
