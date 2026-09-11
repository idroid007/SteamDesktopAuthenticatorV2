import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';
import { startApiServer, type RunningServer } from '@sda/cli/serve';

/**
 * The desktop shell.
 *
 * It starts the same local server the `sda serve` command runs and points a
 * window at it, so the desktop app and a phone on your network see an
 * identical interface backed by identical code. The window talks to
 * 127.0.0.1 and nowhere else.
 */

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;

/** Someone already has the app open, so raise their window instead of a second one. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    // Shown straight away against a black background. Waiting on
    // ready-to-show leaves the window invisible whenever that event does not
    // arrive, and the black fill already prevents the usual white flash.
    show: true,
    backgroundColor: '#000000',
    // macOS keeps its traffic lights. Windows and Linux get a title bar we
    // draw ourselves, so the app is black to the edges.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    autoHideMenuBar: true,
    webPreferences: {
      // The page is plain HTML talking to a local API. It needs none of this.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('did-fail-load', (_event, code, description) => {
    dialog.showErrorBox(
      'Steam Desktop Authenticator',
      `The interface failed to load (${code}). ${description}`,
    );
  });

  void win.loadURL(url);

  // Links to nohax.club and Steam open in the real browser, never in here.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  // Nothing should navigate this window away from the local server.
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  win.on('close', (event) => {
    // Closing hides the window so codes stay a click away in the tray.
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

let isQuitting = false;

/** The three window buttons the preload script exposes to the page. */
ipcMain.on('window:minimize', () => window?.minimize());
ipcMain.on('window:hide', () => window?.hide());
ipcMain.on('window:toggle-maximize', () => {
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

/**
 * A tray icon drawn in code.
 *
 * Issue #75 sat open on SDA v1 for years asking for an icon, and the
 * maintainer wrote "Still really need an icon :/" in the v1.0 plan.
 */
function trayIcon(): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inMark = x >= 3 && x <= 12 && y >= 3 && y <= 12;
      const corner = x + y < 6 || x + y > 24;
      if (inMark && !corner) {
        buffer[i] = 0x28; // B
        buffer[i + 1] = 0x28; // G
        buffer[i + 2] = 0xdc; // R
        buffer[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createTray(url: string): Tray {
  const icon = new Tray(trayIcon());
  icon.setToolTip('Steam Desktop Authenticator');
  icon.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => window?.show() },
      { type: 'separator' },
      {
        label: 'Copy the web address',
        click: () => clipboard.writeText(`${url}/?token=${server?.token ?? ''}`),
      },
      { label: 'Open nohax.club', click: () => void shell.openExternal('https://nohax.club') },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  icon.on('click', () => (window?.isVisible() ? window.hide() : window?.show()));
  return icon;
}

app.whenReady().then(async () => {
  try {
    // Port 0 means the operating system hands us a free one, so two copies
    // of the app never fight over the same port.
    server = await startApiServer({ port: 0 });
  } catch (err) {
    dialog.showErrorBox(
      'Steam Desktop Authenticator',
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
    return;
  }

  window = createWindow(`${server.url}/?token=${server.token}`);
  tray = createTray(server.url);
});

app.on('window-all-closed', () => {
  // macOS keeps apps running with no windows, and the tray still works.
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (window) window.show();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  tray?.destroy();
  void server?.close();
});
