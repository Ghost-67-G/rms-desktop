const { app, BrowserWindow, dialog, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const IS_PACKAGED = app.isPackaged;
const DEFAULT_BACKEND_PORT = process.env.RMS_BACKEND_PORT || '8080';
const FRONTEND_URL = process.env.RMS_FRONTEND_URL || 'http://127.0.0.1:5173';
const BACKEND_HEALTH_URL =
  process.env.RMS_BACKEND_HEALTH_URL || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}/api/health`;
const STARTUP_TIMEOUT_MS = 30000;
const RETRY_INTERVAL_MS = 500;

let mainWindow;
let backendProcess;

const appendMainLog = (message) => {
  try {
    const homeDir = process.env.HOME || app.getPath('home');
    const logsDir = path.join(homeDir, '.rms-desktop', 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'main.log'), `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    // Last-resort fallback: avoid crashing because logger failed.
    // eslint-disable-next-line no-console
    console.error('Failed to write main log:', error);
  }
};

const getResourcePath = (...parts) =>
  IS_PACKAGED ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, ...parts);

const getLogPath = () => {
  const homeDir = process.env.HOME || app.getPath('home');
  const logsDir = path.join(homeDir, '.rms-desktop', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, 'backend.log');
};

const canConnect = (host, port, timeoutMs = 700) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });

const resolveMongoUrl = async () => {
  if (process.env.RMS_MONGODB_URL) {
    return process.env.RMS_MONGODB_URL;
  }

  const host = '127.0.0.1';
  const candidates = [27017, 27018];

  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canConnect(host, port);
    if (reachable) {
      return `mongodb://${host}:${port}/rms`;
    }
  }

  // Keep previous default if nothing is reachable, so the backend log shows a clear DB error.
  return 'mongodb://127.0.0.1:27017/rms';
};

const sanitizeEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== null && typeof value === 'string')
  );

const startBackendForPackagedApp = async () => {
  if (!IS_PACKAGED || backendProcess) {
    return;
  }

  const backendEntry = getResourcePath('backend', 'src', 'index.js');
  const frontendDistPath = getResourcePath('frontend-dist');
  const mongoUrl = await resolveMongoUrl();
  appendMainLog(`startBackendForPackagedApp backendEntry=${backendEntry}`);
  appendMainLog(`resolved mongo url=${mongoUrl}`);

  // SMTP_PORT must be omitted (not empty string) so Joi number validation passes.
  const backendEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    RMS_RUNTIME: 'desktop',
    PORT: DEFAULT_BACKEND_PORT,
    FRONTEND_DIST_PATH: frontendDistPath,
    // null origin from file:// renderer is already allowed by CORS; this value is only used in
    // the production CORS allowed-origins list which is bypassed by the null-origin check.
    FRONTEND_URL: `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
    // Use RMS_MONGODB_URL to avoid accidental cross-project env leakage.
    MONGODB_URL: mongoUrl,
    JWT_SECRET: process.env.JWT_SECRET || 'rms-desktop-local-secret-change-in-production',
    JWT_ACCESS_EXPIRATION_MINUTES: '30',
    JWT_REFRESH_EXPIRATION_DAYS: '30',
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: '10',
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: '10',
    SMTP_HOST: '',
    SMTP_USERNAME: '',
    SMTP_PASSWORD: '',
    EMAIL_FROM: '',
  };

  const safeBackendEnv = sanitizeEnv(backendEnv);

  // Keep SMTP_PORT out of env when empty to satisfy Joi.number() validation.
  if (!safeBackendEnv.SMTP_PORT) {
    delete safeBackendEnv.SMTP_PORT;
  }

  // utilityProcess.fork() is Electron's built-in Node.js child runner for packaged apps.
  // It avoids the ELECTRON_RUN_AS_NODE + fork() issues that cause silent crashes.
  backendProcess = utilityProcess.fork(backendEntry, [], {
    cwd: getResourcePath('backend'),
    env: safeBackendEnv,
    stdio: 'pipe',
  });
  appendMainLog('utilityProcess.fork created backend child process');

  const logStream = fs.createWriteStream(getLogPath(), { flags: 'a' });
  logStream.write(`\n--- Backend started ${new Date().toISOString()} ---\n`);
  logStream.write(`backendEntry=${backendEntry}\n`);
  logStream.write(`frontendDistPath=${frontendDistPath}\n`);
  logStream.write(`mongodbUrl=${safeBackendEnv.MONGODB_URL}\n`);
  logStream.write(`backendPort=${safeBackendEnv.PORT}\n`);

  backendProcess.stdout.on('data', (data) => logStream.write(data));
  backendProcess.stderr.on('data', (data) => logStream.write(data));

  backendProcess.on('exit', (code, signal) => {
    appendMainLog(`backend child exited code=${code} signal=${signal || 'none'}`);
    logStream.write(
      `--- Backend exited with code ${code} signal ${signal || 'none'} at ${new Date().toISOString()} ---\n`
    );
    logStream.end();
    backendProcess = null;
  });
};

const stopBackendForPackagedApp = () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
};

const waitForEndpoint = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const start = Date.now();

    const tryRequest = () => {
      const req = http.get(url, (res) => {
        // Drain response so socket can be reused.
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timeout waiting for ${url}`));
          return;
        }

        setTimeout(tryRequest, RETRY_INTERVAL_MS);
      });

      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timeout waiting for ${url}`));
          return;
        }
        setTimeout(tryRequest, RETRY_INTERVAL_MS);
      });

      req.setTimeout(2000, () => {
        req.destroy();
      });
    };

    tryRequest();
  });

const createWindow = async () => {
  appendMainLog(`createWindow called isPackaged=${IS_PACKAGED}`);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'RMS Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  // Prevent accidental window close from Ctrl/Cmd+W in desktop mode.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCloseShortcut =
      input.type === 'keyDown' && input.key.toLowerCase() === 'w' && (input.control || input.meta);

    if (isCloseShortcut) {
      event.preventDefault();
    }
  });

  try {
    if (IS_PACKAGED) {
      await startBackendForPackagedApp();
    }

    await waitForEndpoint(BACKEND_HEALTH_URL, STARTUP_TIMEOUT_MS);

    // In packaged mode, backend serves frontend on 8080.
    // In dev mode, load from Vite dev server.
    const windowURL = IS_PACKAGED ? 'http://127.0.0.1:8080/' : FRONTEND_URL;
    appendMainLog(`loading windowURL=${windowURL}`);
    await mainWindow.loadURL(windowURL);

    mainWindow.show();
  } catch (error) {
    appendMainLog(`startup error: ${error.message}`);
    const logPath = IS_PACKAGED ? getLogPath() : 'N/A (dev mode)';
    dialog.showErrorBox(
      'RMS Startup Error',
      `Could not connect to local services.\n\nExpected backend: ${BACKEND_HEALTH_URL}\nExpected frontend: ${FRONTEND_URL}\n\n${error.message}\n\nBackend log: ${logPath}`
    );
    app.quit();
  }
};

app.whenReady().then(createWindow);
app.on('ready', () => appendMainLog('electron app ready event emitted'));

app.on('window-all-closed', () => {
  stopBackendForPackagedApp();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackendForPackagedApp();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
