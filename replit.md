# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Includes a Telegram Course Extractor Bot.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Telegram Bot**: node-telegram-bot-api + axios

## Telegram Bot

A Telegram course extractor bot supporting 30+ Indian education platforms.

### Supported Platforms

**Without Login (No Purchase):**
- Chandra Institute, Selection Way, SSC Pinnacle, IFAS Online, Civil Guruji
- TNC Patna, DAMS Delhi, Career Endeavour, Barrack Buddy, Taiyari Karlo
- Unacademy, JRF Adda, Verbal Maths, CDS Journey, FutureKul, Target Board
- AppX (No Login), KGS (No Login)

**VidCrypt Platforms:**
- Eduteria, Utkarsh, Learn with Aman Barkha, ExamFodu, Physics Linx, Kautilya GS
- Sahitya Classes, Chemistry Dias, Trans Easy, Officer Adda v2, ICS Coaching
- DSL Krantikari, MindMap, Quality Education

### Bot Files
- `artifacts/api-server/src/bot/bot.ts` — Main bot logic, menu, handlers
- `artifacts/api-server/src/bot/platforms/index.ts` — Platform registry
- `artifacts/api-server/src/bot/platforms/pinnacle.ts` — Pinnacle extractor
- `artifacts/api-server/src/bot/platforms/appx.ts` — AppX platform extractor
- `artifacts/api-server/src/bot/platforms/vidcrypt.ts` — VidCrypt extractor
- `artifacts/api-server/src/bot/platforms/unacademy.ts` — Unacademy extractor
- `artifacts/api-server/src/bot/platforms/kgs.ts` — KGS extractor
- `artifacts/api-server/src/bot/utils/session.ts` — User session management

### Environment Variables
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
