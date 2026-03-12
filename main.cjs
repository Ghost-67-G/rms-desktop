const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');

const IS_PACKAGED = app.isPackaged;
const DEFAULT_BACKEND_PORT = process.env.RMS_BACKEND_PORT || '8080';
const FRONTEND_URL = process.env.RMS_FRONTEND_URL || 'http://127.0.0.1:5173';
const DEFAULT_MONGO_PORT = process.env.RMS_MONGO_PORT || '27027';
const DEFAULT_MONGO_DB_NAME = process.env.RMS_MONGO_DB_NAME || 'rms';
const BACKEND_HEALTH_URL =
  process.env.RMS_BACKEND_HEALTH_URL || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}/api/health`;
const STARTUP_TIMEOUT_MS = 45000;
const RETRY_INTERVAL_MS = 500;
const LOG_RETENTION_DAYS = 14;
const BACKUP_RETENTION_DAYS = 30;
const AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_MANIFEST_URL = process.env.RMS_UPDATE_MANIFEST_URL || '';

let mainWindow;
let backendProcess;
let mongoProcess;
let runtimeState = null;

const getDesktopPaths = () => {
  const homeDir = process.env.HOME || app.getPath('home');
  const rootDir = path.join(homeDir, '.rms-desktop');

  return {
    rootDir,
    logsDir: path.join(rootDir, 'logs'),
    backupsDir: path.join(rootDir, 'backups'),
    crashDir: path.join(rootDir, 'crashes'),
    mongoDir: path.join(rootDir, 'mongo'),
    mongoDataDir: path.join(rootDir, 'mongo', 'data'),
    mongoLogPath: path.join(rootDir, 'logs', 'mongo.log'),
    backendLogPath: path.join(rootDir, 'logs', 'backend.log'),
    mainLogPath: path.join(rootDir, 'logs', 'main.log'),
  };
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const ensureDesktopDirectories = () => {
  const paths = getDesktopPaths();
  ensureDir(paths.rootDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.backupsDir);
  ensureDir(paths.crashDir);
  ensureDir(paths.mongoDir);
  ensureDir(paths.mongoDataDir);
  return paths;
};

const appendMainLog = (message) => {
  try {
    const paths = ensureDesktopDirectories();
    fs.appendFileSync(paths.mainLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    // Last-resort fallback: avoid crashing because logger failed.
    // eslint-disable-next-line no-console
    console.error('Failed to write main log:', error);
  }
};

const getResourcePath = (...parts) =>
  IS_PACKAGED ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, ...parts);

const getLogPath = () => ensureDesktopDirectories().backendLogPath;

const cleanupOldFiles = (directoryPath, retentionDays) => {
  if (!fs.existsSync(directoryPath)) {
    return;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    const stats = fs.statSync(entryPath);

    if (entry.isDirectory()) {
      cleanupOldFiles(entryPath, retentionDays);
      if (fs.readdirSync(entryPath).length === 0) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
      return;
    }

    if (stats.mtimeMs < cutoffMs) {
      fs.rmSync(entryPath, { force: true });
    }
  });
};

const writeCrashLog = (label, error) => {
  try {
    const paths = ensureDesktopDirectories();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const crashLogPath = path.join(paths.crashDir, `${label}-${timestamp}.log`);
    const content = error instanceof Error ? error.stack || error.message : String(error);
    fs.writeFileSync(crashLogPath, `${new Date().toISOString()}\n${content}\n`);
    appendMainLog(`crash log written to ${crashLogPath}`);
  } catch (writeError) {
    appendMainLog(`failed to write crash log: ${writeError.message}`);
  }
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

const isExecutableFile = (filePath) => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const findMongoBinary = () => {
  const candidates = [
    process.env.RMS_MONGOD_PATH,
    getResourcePath('mongodb', 'bin', 'mongod'),
    path.join(__dirname, 'vendor', 'mongodb', 'bin', 'mongod'),
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
  ].filter(Boolean);

  const whichResult = spawnSync('which', ['mongod'], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    candidates.push(whichResult.stdout.trim());
  }

  return candidates.find((candidate) => fs.existsSync(candidate) && isExecutableFile(candidate)) || null;
};

const waitForTcpPort = async (port, timeoutMs) => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canConnect('127.0.0.1', Number(port));
    if (reachable) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  throw new Error(`Timeout waiting for local MongoDB on 127.0.0.1:${port}`);
};

const sanitizeEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== null && typeof value === 'string')
  );

const resolveMongoRuntime = async () => {
  if (process.env.RMS_MONGODB_URL) {
    return {
      mongoUrl: process.env.RMS_MONGODB_URL,
      source: 'env',
      managed: false,
      binaryPath: null,
      dataDir: null,
      port: null,
    };
  }

  const mongoBinary = findMongoBinary();
  if (!mongoBinary) {
    throw new Error(
      'MongoDB server binary was not found. Set RMS_MONGOD_PATH or place mongod under desktop/vendor/mongodb/bin before packaging.'
    );
  }

  const paths = ensureDesktopDirectories();
  const mongoUrl = `mongodb://127.0.0.1:${DEFAULT_MONGO_PORT}/${DEFAULT_MONGO_DB_NAME}`;

  if (await canConnect('127.0.0.1', Number(DEFAULT_MONGO_PORT))) {
    return {
      mongoUrl,
      source: 'existing-local-port',
      managed: false,
      binaryPath: mongoBinary,
      dataDir: paths.mongoDataDir,
      port: DEFAULT_MONGO_PORT,
    };
  }

  const mongoLogStream = fs.createWriteStream(paths.mongoLogPath, { flags: 'a' });
  mongoLogStream.write(`\n--- MongoDB start ${new Date().toISOString()} ---\n`);

  mongoProcess = spawn(
    mongoBinary,
    [
      '--dbpath',
      paths.mongoDataDir,
      '--bind_ip',
      '127.0.0.1',
      '--port',
      DEFAULT_MONGO_PORT,
      '--logappend',
      '--logpath',
      paths.mongoLogPath,
    ],
    {
      cwd: path.dirname(mongoBinary),
      env: sanitizeEnv({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  mongoProcess.stdout.on('data', (data) => mongoLogStream.write(data));
  mongoProcess.stderr.on('data', (data) => mongoLogStream.write(data));
  mongoProcess.on('exit', (code, signal) => {
    appendMainLog(`managed mongo exited code=${code} signal=${signal || 'none'}`);
    mongoLogStream.write(
      `--- MongoDB exited with code ${code} signal ${signal || 'none'} at ${new Date().toISOString()} ---\n`
    );
    mongoLogStream.end();
    mongoProcess = null;
  });

  appendMainLog(`starting managed mongo binary=${mongoBinary} port=${DEFAULT_MONGO_PORT}`);
  await waitForTcpPort(DEFAULT_MONGO_PORT, STARTUP_TIMEOUT_MS);

  return {
    mongoUrl,
    source: 'managed-local-process',
    managed: true,
    binaryPath: mongoBinary,
    dataDir: paths.mongoDataDir,
    port: DEFAULT_MONGO_PORT,
  };
};

const createBackupFileName = (prefix) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${timestamp}.json`;
};

const runExportScript = (outputPath) =>
  new Promise((resolve, reject) => {
    const exportScript = getResourcePath('backend', 'src', 'scripts', 'exportDesktopData.js');

    const exportProcess = utilityProcess.fork(exportScript, [], {
      cwd: getResourcePath('backend'),
      env: sanitizeEnv({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        NODE_ENV: 'production',
        MONGODB_URL: runtimeState?.mongoUrl,
        RMS_EXPORT_PATH: outputPath,
        RMS_APP_VERSION: app.getVersion(),
      }),
      stdio: 'pipe',
    });

    let stderr = '';

    exportProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    exportProcess.on('exit', (code) => {
      if (code === 0) {
        resolve(outputPath);
        return;
      }

      reject(new Error(stderr.trim() || `Desktop export failed with code ${code}`));
    });
  });

const createBackup = async (reason = 'manual-backup') => {
  const paths = ensureDesktopDirectories();
  const backupPath = path.join(paths.backupsDir, createBackupFileName(reason));
  appendMainLog(`creating backup at ${backupPath}`);
  return runExportScript(backupPath);
};

const getLatestAutomaticBackupAge = () => {
  const paths = ensureDesktopDirectories();
  const automaticBackups = fs
    .readdirSync(paths.backupsDir)
    .filter((fileName) => fileName.startsWith('auto-backup-'))
    .map((fileName) => path.join(paths.backupsDir, fileName))
    .map((filePath) => fs.statSync(filePath).mtimeMs)
    .sort((left, right) => right - left);

  return automaticBackups[0] || 0;
};

const maybeCreateAutomaticBackup = () => {
  if (!runtimeState?.mongoUrl) {
    return;
  }

  if (Date.now() - getLatestAutomaticBackupAge() < AUTOMATIC_BACKUP_INTERVAL_MS) {
    return;
  }

  createBackup('auto-backup').catch((error) => {
    appendMainLog(`automatic backup failed: ${error.message}`);
  });
};

const listBackups = () => {
  const paths = ensureDesktopDirectories();
  return fs
    .readdirSync(paths.backupsDir)
    .map((fileName) => {
      const filePath = path.join(paths.backupsDir, fileName);
      const stats = fs.statSync(filePath);
      return {
        fileName,
        filePath,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
};

const fetchUpdateManifest = (manifestUrl) =>
  new Promise((resolve, reject) => {
    const client = manifestUrl.startsWith('https:') ? https : http;

    client
      .get(manifestUrl, (response) => {
        if (!response.statusCode || response.statusCode >= 400) {
          reject(new Error(`Update manifest request failed with status ${response.statusCode}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid update manifest JSON: ${error.message}`));
          }
        });
      })
      .on('error', reject);
  });

const compareVersions = (left, right) => {
  const leftParts = left.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = right.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
};

const checkForUpdates = async () => {
  const currentVersion = app.getVersion();

  if (!UPDATE_MANIFEST_URL) {
    return {
      configured: false,
      currentVersion,
      strategy: 'manual-installer',
    };
  }

  const manifest = await fetchUpdateManifest(UPDATE_MANIFEST_URL);
  const latestVersion = manifest.version || currentVersion;

  return {
    configured: true,
    strategy: 'manual-installer',
    currentVersion,
    latestVersion,
    available: compareVersions(latestVersion, currentVersion) > 0,
    downloadUrl: manifest.downloadUrl || null,
    notes: manifest.notes || '',
    checkedAt: new Date().toISOString(),
  };
};

const registerDesktopIpc = () => {
  ipcMain.handle('desktop:get-runtime-info', async () => {
    const paths = ensureDesktopDirectories();

    return {
      appVersion: app.getVersion(),
      isPackaged: IS_PACKAGED,
      backendUrl: `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
      mongo: runtimeState,
      paths: {
        rootDir: paths.rootDir,
        logsDir: paths.logsDir,
        backupsDir: paths.backupsDir,
      },
    };
  });

  ipcMain.handle('desktop:create-backup', async () => ({
    filePath: await createBackup('manual-backup'),
  }));
  ipcMain.handle('desktop:list-backups', async () => listBackups());
  ipcMain.handle('desktop:check-for-updates', async () => checkForUpdates());
  ipcMain.handle('desktop:open-path', async (_event, kind) => {
    const paths = ensureDesktopDirectories();
    const targetPath =
      kind === 'logs' ? paths.logsDir : kind === 'backups' ? paths.backupsDir : paths.rootDir;
    const errorMessage = await shell.openPath(targetPath);

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    return { opened: true, path: targetPath };
  });
};

const startBackendForPackagedApp = async () => {
  if (!IS_PACKAGED || backendProcess) {
    return;
  }

  const backendEntry = getResourcePath('backend', 'src', 'index.js');
  const frontendDistPath = getResourcePath('frontend-dist');
  const mongoRuntime = await resolveMongoRuntime();
  runtimeState = mongoRuntime;
  appendMainLog(`startBackendForPackagedApp backendEntry=${backendEntry}`);
  appendMainLog(`resolved mongo url=${mongoRuntime.mongoUrl}`);
  appendMainLog(`mongo source=${mongoRuntime.source}`);

  const backendEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    RMS_RUNTIME: 'desktop',
    PORT: DEFAULT_BACKEND_PORT,
    FRONTEND_DIST_PATH: frontendDistPath,
    FRONTEND_URL: `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`,
    MONGODB_URL: mongoRuntime.mongoUrl,
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
  if (!safeBackendEnv.SMTP_PORT) {
    delete safeBackendEnv.SMTP_PORT;
  }

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
  logStream.write(`mongoSource=${mongoRuntime.source}\n`);
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

const stopManagedMongoServer = () => {
  if (mongoProcess) {
    mongoProcess.kill('SIGTERM');
    mongoProcess = null;
  }
};

const stopBackendForPackagedApp = () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
};

const runStartupChecks = () => {
  const paths = ensureDesktopDirectories();
  cleanupOldFiles(paths.logsDir, LOG_RETENTION_DAYS);
  cleanupOldFiles(paths.crashDir, LOG_RETENTION_DAYS);
  cleanupOldFiles(paths.backupsDir, BACKUP_RETENTION_DAYS);
};

const waitForEndpoint = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const startTime = Date.now();

    const tryRequest = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`Timeout waiting for ${url}`));
          return;
        }

        setTimeout(tryRequest, RETRY_INTERVAL_MS);
      });

      req.on('error', () => {
        if (Date.now() - startTime >= timeoutMs) {
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
  runStartupChecks();
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

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const message = `renderer process exited reason=${details.reason} code=${details.exitCode}`;
    appendMainLog(message);
    writeCrashLog('renderer', message);
  });

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

    const windowURL = IS_PACKAGED ? 'http://127.0.0.1:8080/' : FRONTEND_URL;
    appendMainLog(`loading windowURL=${windowURL}`);
    await mainWindow.loadURL(windowURL);

    mainWindow.show();
    maybeCreateAutomaticBackup();
  } catch (error) {
    appendMainLog(`startup error: ${error.message}`);
    writeCrashLog('startup', error);
    const logPath = IS_PACKAGED ? getLogPath() : 'N/A (dev mode)';
    dialog.showErrorBox(
      'RMS Startup Error',
      `Could not connect to local services.\n\nExpected backend: ${BACKEND_HEALTH_URL}\nExpected frontend: ${FRONTEND_URL}\n\n${error.message}\n\nBackend log: ${logPath}`
    );
    app.quit();
  }
};

registerDesktopIpc();

app.whenReady().then(createWindow);
app.on('ready', () => appendMainLog('electron app ready event emitted'));

app.on('window-all-closed', () => {
  stopBackendForPackagedApp();
  stopManagedMongoServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackendForPackagedApp();
  stopManagedMongoServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

process.on('uncaughtException', (error) => {
  appendMainLog(`uncaught exception: ${error.message}`);
  writeCrashLog('main-process', error);
});

process.on('unhandledRejection', (error) => {
  const rejection = error instanceof Error ? error : new Error(String(error));
  appendMainLog(`unhandled rejection: ${rejection.message}`);
  writeCrashLog('main-process', rejection);
});
