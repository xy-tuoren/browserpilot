# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo (`pnpm` workspace) with zero Playwright/Puppeteer runtime dependencies.
- Added `@devpilot/protocol` package defining:
  - Complete shared data contracts for Tabs, AXTree Snapshots, Console/Network capture, CSS Styles, Live JS Debugger, React Fiber inspection, Performance/Web Vitals, Screen Recording, and multi-session management.
  - Bidirectional JSON-RPC bridge protocol between Chrome MV3 Extension, Native Messaging Host, and Local Daemon.
  - Chrome Native Messaging 4-byte little-endian binary framing encoder/decoder (`encodeNativeMessage`, `NativeMessageDecoder`).
  - Safety guard (`BLOCKED_PROFILE_WIDE_CDP_COMMANDS`) blocking destructive profile-wide CDP commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`).
  - Unit tests verifying framing edge cases (chunked streams, multi-byte UTF-8, oversized message rejection) and protocol helpers.
