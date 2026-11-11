# AGENTS.md — PFM.ai mobile (apps/mobile)

## Stack facts
- Expo SDK 58, React Native 0.88, expo-router, TypeScript, pnpm monorepo.
- App code lives in apps/mobile/src. Dev machine is Windows; target devices are iPhone (iOS 26+ for liquid glass) and Android.
- Web variants exist (*.web.tsx). Never break web or Android while changing iOS UI.

## Before any UI work
- Read the Expo SDK version from apps/mobile/package.json and read the docs for THAT version
  (docs.expo.dev/versions/v<SDK>/sdk/...; append .md to any docs URL to get Markdown; llms.txt has the full index).
- Never guess props or import paths. If a doc page and the installed package disagree, trust the installed package types.

## Native iOS UI mapping (mandatory)
- Date/time input: DateTimePicker from @expo/ui/swift-ui, wrapped in <Host>.
- Option pickers: Picker from @expo/ui/swift-ui (menu / segmented / wheel variants).
- Dropdown / action menus: ContextMenu from @expo/ui/swift-ui. Do not build custom Modal menus.
- Icons on iOS: SF Symbols via SymbolView from expo-symbols. Keep the existing Material icon as the Android/web fallback.
- Sheets/forms: expo-router Stack screen with presentation "formSheet" (when a task asks for it).
- Do NOT use NativeTabs. The custom FloatingTabBar is kept on purpose (project decision).

## Liquid glass rules (expo-glass-effect)
- Real glass (GlassView) is ONLY for floating control layers: tab bar, "+" button, sheets, floating buttons.
- Content cards (GlassCard) stay as they are. Do not convert them to GlassView.
- Never set opacity < 1 on a GlassView or on ANY of its ancestors (the glass stops rendering).
  To fade glass, toggle glassEffectStyle with { style, animate: true, animationDuration }.
  To hide a floating bar, prefer translateY over opacity.
- Do not give GlassView an opaque/near-opaque backgroundColor or a fake border. Use tintColor if a tint is needed.
- GlassView only works on iOS 26+ and falls back to a plain View elsewhere. Always check isLiquidGlassAvailable()
  and keep the legacy translucent style (background + border) as the fallback path.
- Use GlassContainer (with spacing) only when several GlassView elements should visually merge.

## Forbidden
- Re-implementing a native control in JS when a native equivalent above exists.
- Adding new UI dependencies without asking.
- Replacing react-native-paper wholesale unless the task explicitly says so.

## Project conventions
- User-facing strings come from "@/messages/vi" (and the active language helper). No hard-coded UI strings.
- Keep accessibility labels/roles/states on every interactive element.
- Code comments in English (describe what the function does). Variable and function names in English only.
- Run `pnpm check` (lint + typecheck + test) before reporting. Update existing tests
  (for example floating-tab-bar.test.ts, responsive-layout.test.ts) so they reflect the REAL behavior.
  A test that passes but does not reflect real behavior is a failure.

## Decisions and trade-offs
- If a task involves a trade-off (a choice with real downsides either way), STOP and ask. Do not choose silently.
- If the task is ambiguous or information is missing, ask first. Do not assume.

## Reporting (end of every task)
- Summarize what changed to handle which case (no line-by-line file listing unless needed).
- List every case and edge case tested with its result (for example: iOS 26 glass visible, iOS < 26 fallback,
  light/dark, tab bar hidden/shown, narrow width, Android/web unchanged).
- Explicitly list what you could NOT verify (for example anything that needs a real iPhone).
- Commit messages must describe exactly what was done in that commit.
- Finish by asking whether anything else should be changed or added.
