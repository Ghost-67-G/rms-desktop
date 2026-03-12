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
   - `sudo dpkg -i desktop/release/RMS-Desktop-*-linux-amd64.deb`
   - if dependencies are missing: `sudo apt-get -f install`

After installing `.deb`, launch `RMS Desktop` from app menu/desktop shortcut.

The packaged app includes:
- frontend production build (`frontend/dist`)
- backend source (`backend/src`)
- backend runtime dependencies (`backend/node_modules`)

## Local Database Runtime

The desktop app now manages its own local MongoDB process and stores data under:

- `~/.rms-desktop/mongo/data`
- logs under `~/.rms-desktop/logs`
- backups under `~/.rms-desktop/backups`

Startup order in packaged mode:

1. Electron prepares local data, log, crash, and backup directories.
2. Electron starts a local `mongod` process on `127.0.0.1:27027` using the private desktop data directory.
3. Electron starts the backend with `MONGODB_URL=mongodb://127.0.0.1:27027/rms`.
4. Electron loads the backend-served frontend after `/api/health` is ready.

Binary lookup order for MongoDB:

1. `RMS_MONGOD_PATH`
2. bundled binary at `desktop/vendor/mongodb/bin/mongod` during build, or packaged `resources/mongodb/bin/mongod`
3. system binary such as `/usr/bin/mongod`

This removes the dependency on a separately managed MongoDB system service. If you want the installer to be fully self-contained, place the production `mongod` binary tree under `desktop/vendor/mongodb/` before packaging.

### Backups and Diagnostics

- The desktop runtime keeps automatic JSON backups at most once every 24 hours.
- Manual backups can be triggered through the preload API exposed on `window.rmsDesktop.createBackup()`.
- Old logs and crash files are cleaned up automatically on startup.

### Update Strategy

- The desktop app exposes a manual update-check API.
- Set `RMS_UPDATE_MANIFEST_URL` to a JSON manifest such as:

```json
{
   "version": "0.1.1",
   "downloadUrl": "https://example.com/RMS-Desktop-0.1.1-linux-x64.deb",
   "notes": "Bug fixes and packaging updates"
}
```

- The current strategy is manual installer replacement rather than silent auto-update.

## Notes

- Desktop runtime now supports managed local services, backup export, and update checks.
- Bundling a MongoDB binary into the installer is optional and controlled through `desktop/vendor/mongodb/`.
