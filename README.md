# RMS Desktop Wrapper (Electron)

This folder contains the first desktop wrapper for RMS.

## Dev Run

1. Install dependencies in each app:
   - `cd frontend && bun install`
   - `cd backend && bun install`
   - `cd desktop && bun install`
2. Run desktop mode:
   - `cd desktop && bun run dev`

`bun run dev` starts:
- Frontend Vite app on `http://127.0.0.1:5173`
- Backend API on `http://127.0.0.1:8080`
- Electron window that loads the frontend after backend health is ready

## Build Executables

From `desktop/`:

- Linux package (AppImage + deb): `bun run dist:linux`
- Linux deb only (recommended if AppImage fails): `bun run dist:linux:deb`
- Windows installer (NSIS): `bun run dist:win`
- Auto-detect current platform: `bun run dist`

Build output is written to `desktop/release/`.

### Linux Run Notes

- If AppImage fails with `libfuse.so.2`, either install FUSE2 or use the `.deb` package.
- Install `.deb`:
   - `sudo dpkg -i desktop/release/rms-desktop_0.1.0_amd64.deb`
   - if dependencies are missing: `sudo apt-get -f install`

After installing `.deb`, launch `RMS Desktop` from app menu/desktop shortcut.

The packaged app includes:
- frontend production build (`frontend/dist`)
- backend source (`backend/src`)
- backend runtime dependencies (`backend/node_modules`)

## Current Limitation

The executable currently expects a local MongoDB instance to be available at:

`mongodb://127.0.0.1:27017/rms`

Embedded MongoDB process management is phase 2.

## Notes

- This is phase 1 (dev wrapper).
- Installer packaging and embedded MongoDB process startup will be phase 2.
