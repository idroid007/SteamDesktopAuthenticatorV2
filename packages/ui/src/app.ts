/**
 * The interface, shared by the desktop app and the browser.
 *
 * Electron loads this from the local server, and a phone on your network loads
 * the same files. One design, one code path, every platform.
 *
 * Everything the product does has a control here. Nobody should need a terminal
 * to create a vault, import an authenticator, sign in, link a new one or change
 * a setting.
 */

/* ---------------------------------------------------------------- types */

interface AccountView {
  id: string;
  label: string;
  accountName: string;
  canConfirm: boolean;
  signedIn: boolean;
  hasRevocationCode: boolean;
}

interface ConfirmationView {
  id: string;
  nonce: string;
  kind: string;
  creatorId: string;
  headline: string;
  summary: string[];
  when: string;
  createdAt: number;
  icon?: string;
}

interface AutoConfirmRules {
  enabled: boolean;
  market: boolean;
  trades: boolean;
  allowedPartners: string[];
  maxPerHour: number;
  holdSeconds: number;
}

interface Settings {
  autoCheckConfirmations: boolean;
  checkIntervalSeconds: number;
  notifyOnNewConfirmation: boolean;
  lockAfterIdleMinutes: number;
  autoConfirm: AutoConfirmRules;
}

/** The desktop shell injects this. A browser tab gets nothing, which is fine. */
interface ShellBridge {
  platform: string;
  frameless: boolean;
  minimize(): void;
  toggleMaximize(): void;
  hide(): void;
}

const shell = (window as unknown as { sdaShell?: ShellBridge }).sdaShell;

const RING_CIRCUMFERENCE = 339.29;
const CODE_PERIOD = 30;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};
const input = (id: string) => $(id) as HTMLInputElement;
const area = (id: string) => $(id) as HTMLTextAreaElement;
const dialog = (id: string) => $(id) as HTMLDialogElement;

/* ------------------------------------------------------------------ api */

function readToken(): string {
  const fromQuery = new URL(location.href).searchParams.get('token');
  if (fromQuery) {
    sessionStorage.setItem('sda-token', fromQuery);
    history.replaceState(null, '', location.pathname);
    return fromQuery;
  }
  return sessionStorage.getItem('sda-token') ?? '';
}

const token = readToken();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* ---------------------------------------------------------------- state */

const state = {
  accounts: [] as AccountView[],
  activeId: '',
  filter: '',
  codes: new Map<string, { code: string; expiresAt: number }>(),
  counts: new Map<string, number>(),
  confirmations: [] as ConfirmationView[],
  settings: null as Settings | null,
  version: '',
  vaultPath: '',
  exposedToNetwork: false,
  linkPendingId: '',
};

/* --------------------------------------------------------------- toasts */

function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

function transition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    doc.startViewTransition(update);
  } else {
    update();
  }
}

/** Closes any dialog from a button carrying data-close. */
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-close]')) {
    target.closest('dialog')?.close();
  }
});

/* ------------------------------------------------------- generic prompt */

interface PromptOptions {
  title: string;
  text?: string;
  label?: string;
  value?: string;
  confirmText?: string;
  /** Shows a read-only block instead of an input, for revealing a code. */
  reveal?: string;
}

function prompt(options: PromptOptions): Promise<string | null> {
  const d = dialog('prompt-dialog');
  $('prompt-title').textContent = options.title;
  $('prompt-text').textContent = options.text ?? '';
  $('prompt-text').hidden = !options.text;

  const revealBox = $('prompt-reveal');
  const field = $('prompt-field');
  if (options.reveal) {
    revealBox.textContent = options.reveal;
    revealBox.hidden = false;
    field.hidden = true;
  } else {
    revealBox.hidden = true;
    field.hidden = false;
    $('prompt-label').textContent = options.label ?? '';
    input('prompt-input').value = options.value ?? '';
  }
  ($('prompt-go') as HTMLButtonElement).textContent = options.confirmText ?? 'OK';

  d.showModal();
  if (!options.reveal) setTimeout(() => input('prompt-input').select(), 40);

  return new Promise((resolve) => {
    d.addEventListener(
      'close',
      () => resolve(d.returnValue === 'go' ? (options.reveal ?? input('prompt-input').value) : null),
      { once: true },
    );
  });
}

async function confirmDanger(title: string, text: string, confirmText: string): Promise<boolean> {
  return (await prompt({ title, text, label: 'Type YES to continue', confirmText })) === 'YES';
}

/* ----------------------------------------------------------------- gate */

let gateMode: 'unlock' | 'setup' = 'unlock';

async function boot(): Promise<void> {
  try {
    const s = await api<{
      vaultExists: boolean;
      locked: boolean;
      vault: string;
      exposedToNetwork: boolean;
      version?: string;
    }>('/state');
    state.vaultPath = s.vault;
    state.exposedToNetwork = s.exposedToNetwork;
    state.version = s.version ?? '';

    if (!s.vaultExists) showGate('setup');
    else if (s.locked) showGate('unlock');
    else await showApp();
  } catch (err) {
    showGate('unlock');
    gateError(message(err));
  }
}

function showGate(mode: 'unlock' | 'setup'): void {
  gateMode = mode;
  const creating = mode === 'setup';

  $('gate').hidden = false;
  $('app').hidden = true;
  $('gate-error').hidden = true;
  $('confirm-field').hidden = !creating;
  $('gate-note').hidden = !creating;
  $('gate-lede').textContent = creating
    ? 'Nothing is stored yet. Pick a passphrase and this machine becomes your authenticator.'
    : 'Your codes live on this machine. Unlock the vault to read them.';
  $('passphrase-label').textContent = creating ? 'New vault passphrase' : 'Vault passphrase';
  ($('unlock-btn') as HTMLButtonElement).textContent = creating ? 'Create vault' : 'Unlock';
  input('passphrase').autocomplete = creating ? 'new-password' : 'current-password';
  $('gate-path').textContent = state.vaultPath ? `Vault: ${state.vaultPath}` : '';

  input('passphrase').focus();
}

function gateError(text: string): void {
  const el = $('gate-error');
  el.textContent = text;
  el.hidden = false;
}

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pass = input('passphrase');
  const button = $('unlock-btn') as HTMLButtonElement;
  $('gate-error').hidden = true;

  if (gateMode === 'setup') {
    if (pass.value.length < 8) return gateError('Use at least 8 characters.');
    if (pass.value !== input('passphrase-confirm').value) {
      return gateError('Those two do not match.');
    }
  }

  button.disabled = true;
  button.textContent = gateMode === 'setup' ? 'Creating' : 'Unlocking';

  try {
    await post(gateMode === 'setup' ? '/setup' : '/unlock', { passphrase: pass.value });
    pass.value = '';
    input('passphrase-confirm').value = '';
    await showApp();
    if (gateMode === 'setup') {
      toast('Vault created. Add an account to start.');
      openAdd();
    }
  } catch (err) {
    gateError(message(err));
    pass.select();
  } finally {
    button.disabled = false;
    button.textContent = gateMode === 'setup' ? 'Create vault' : 'Unlock';
  }
});

$('lock-btn').addEventListener('click', async () => {
  await post('/lock').catch(() => {});
  state.codes.clear();
  state.confirmations = [];
  events?.close();
  events = null;
  showGate('unlock');
});

/* ------------------------------------------------------------------ app */

async function showApp(): Promise<void> {
  $('gate').hidden = true;
  $('app').hidden = false;
  await Promise.all([loadSettings(), loadAccounts()]);
  openEventStream();
  void askNotificationPermission();
}

async function loadSettings(): Promise<void> {
  try {
    const { settings } = await api<{ settings: Settings }>('/settings');
    state.settings = settings;
    paintAutoChip();
  } catch {
    // Settings are a convenience. The app still works without them.
  }
}

async function loadAccounts(): Promise<void> {
  const { accounts } = await api<{ accounts: AccountView[] }>('/accounts');
  state.accounts = accounts;
  $('account-count').textContent = String(accounts.length);
  $('search').hidden = accounts.length < 5;

  if (accounts.length === 0) {
    renderAccounts();
    renderNoAccounts();
    return;
  }
  if (!accounts.some((a) => a.id === state.activeId)) {
    const useful =
      accounts.find((a) => a.canConfirm && a.signedIn) ??
      accounts.find((a) => a.canConfirm) ??
      accounts[0]!;
    state.activeId = useful.id;
  }
  renderAccounts();
  await Promise.all([refreshCode(state.activeId), loadConfirmations()]);
  void warmOtherCodes();
}

function renderNoAccounts(): void {
  $('confirms').innerHTML = '';
  const panel = $('code-panel');
  panel.hidden = true;
  const body = $('confirms');
  body.innerHTML = `
    <div class="empty">
      <div class="empty__title">No accounts yet.</div>
      <div class="empty__hint">Add one to see codes and confirmations here.</div>
    </div>`;
  const cta = document.createElement('button');
  cta.className = 'btn btn--primary empty__cta';
  cta.textContent = 'Add an account';
  cta.addEventListener('click', openAdd);
  body.append(cta);
}

function visibleAccounts(): AccountView[] {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.accounts;
  return state.accounts.filter(
    (a) => a.label.toLowerCase().includes(q) || a.accountName.toLowerCase().includes(q) || a.id.includes(q),
  );
}

function renderAccounts(): void {
  const list = $('accounts');
  list.innerHTML = '';

  for (const account of visibleAccounts()) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'account';
    btn.setAttribute('aria-selected', String(account.id === state.activeId));

    const left = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'account__name';
    name.textContent = account.label;
    const sub = document.createElement('span');
    sub.className = 'account__sub';
    sub.textContent = account.signedIn ? account.id : 'signed out';
    left.append(name, sub);

    const right = document.createElement('span');
    const count = state.counts.get(account.id) ?? 0;
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(count);
      right.append(badge);
    } else {
      const code = document.createElement('span');
      code.className = 'account__code';
      code.textContent = state.codes.get(account.id)?.code ?? '·····';
      right.append(code);
    }

    btn.append(left, right);
    btn.addEventListener('click', () => selectAccount(account.id));
    li.append(btn);
    list.append(li);
  }
}

async function selectAccount(id: string): Promise<void> {
  state.activeId = id;
  transition(() => {
    renderAccounts();
    paintCode();
  });
  await Promise.all([refreshCode(id), loadConfirmations()]);
}

const activeAccount = (): AccountView | undefined =>
  state.accounts.find((a) => a.id === state.activeId);

$('search').addEventListener('input', (event) => {
  state.filter = (event.target as HTMLInputElement).value;
  renderAccounts();
});

/* ----------------------------------------------------------------- code */

async function refreshCode(id: string): Promise<void> {
  try {
    const { code, expiresIn } = await api<{ code: string; expiresIn: number }>(
      `/accounts/${id}/code`,
    );
    state.codes.set(id, { code, expiresAt: Date.now() + expiresIn * 1000 });
    if (id === state.activeId) paintCode();
    renderAccounts();
  } catch {
    // A single failed code should not blank the interface.
  }
}

async function warmOtherCodes(): Promise<void> {
  for (const account of state.accounts) {
    if (account.id === state.activeId) continue;
    await refreshCode(account.id);
  }
}

function paintCode(): void {
  const account = activeAccount();
  $('code-panel').hidden = !account;
  if (!account) return;

  $('active-name').textContent = account.label;
  $('active-id').textContent = account.id;

  const entry = state.codes.get(account.id);
  const value = $('code-value');
  const ring = $('ring-fill') as unknown as SVGCircleElement;
  const countdown = $('countdown');

  if (!entry) {
    value.textContent = '•••••';
    countdown.textContent = '';
    return;
  }

  const remaining = Math.max(0, (entry.expiresAt - Date.now()) / 1000);
  value.textContent = entry.code;
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - remaining / CODE_PERIOD));
  ring.classList.toggle('is-low', remaining <= 10 && remaining > 5);
  ring.classList.toggle('is-critical', remaining <= 5);
  countdown.textContent = `${Math.ceil(remaining)}s left`;

  if (remaining <= 0.2) void refreshCode(account.id);
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    toast('This browser blocked the clipboard.', 'error');
  }
}

const copyCode = () => {
  const entry = state.codes.get(state.activeId);
  if (entry) void copy(entry.code, 'Code');
};

$('code').addEventListener('click', copyCode);
$('copy-btn').addEventListener('click', copyCode);
$('active-id').addEventListener('click', () => void copy(state.activeId, 'SteamID'));

/* -------------------------------------------------------- confirmations */

const tagFor = (kind: string) =>
  kind === 'trade' ? 'tag tag--trade' : kind === 'market' ? 'tag tag--market' : 'tag';

function renderConfirmations(list: ConfirmationView[]): void {
  const body = $('confirms');
  const account = activeAccount();
  body.innerHTML = '';
  $('bulk').hidden = list.length < 2;

  if (!account) return;

  if (!account.canConfirm) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty__title">This account cannot answer confirmations.</div>
        <div class="empty__hint">Its maFile carried no identity secret. Import one that has it.</div>
      </div>`;
    return;
  }

  if (!account.signedIn) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty__title">Signed out of Steam.</div>
      </div>`;
    const button = document.createElement('button');
    button.className = 'btn btn--primary empty__cta';
    button.textContent = `Sign in as ${account.accountName}`;
    button.addEventListener('click', () => openLogin(account));
    body.append(button);
    return;
  }

  if (list.length === 0) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty__title">Nothing waiting.</div>
        <div class="empty__hint">New trades and listings show up here on their own.</div>
        <a class="empty__link" href="https://nohax.club/rep" target="_blank" rel="noreferrer noopener">
          Look up a trader on nohax.club before your next deal
        </a>
      </div>`;
    return;
  }

  for (const conf of list) body.append(confirmationCard(conf));
}

function confirmationCard(conf: ConfirmationView): HTMLElement {
  const card = document.createElement('article');
  card.className = 'conf';
  card.dataset['id'] = conf.id;

  if (conf.icon) {
    const img = document.createElement('img');
    img.className = 'conf__icon';
    img.src = conf.icon;
    img.alt = '';
    img.loading = 'lazy';
    card.append(img);
  } else {
    const glyph = document.createElement('div');
    glyph.className = 'conf__icon conf__icon--glyph';
    glyph.textContent = conf.kind.slice(0, 3);
    card.append(glyph);
  }

  const body = document.createElement('div');
  body.className = 'conf__body';

  const headline = document.createElement('div');
  headline.className = 'conf__headline';
  headline.textContent = conf.headline;
  body.append(headline);

  if (conf.summary.length > 0) {
    const summary = document.createElement('div');
    summary.className = 'conf__summary';
    summary.textContent = conf.summary.join(' · ');
    body.append(summary);
  }

  const meta = document.createElement('div');
  meta.className = 'conf__meta';

  const tag = document.createElement('span');
  tag.className = tagFor(conf.kind);
  tag.textContent = conf.kind;
  meta.append(tag);

  const when = document.createElement('span');
  when.className = 'conf__when';
  when.textContent = conf.when;
  meta.append(when);

  // Steam names the trade partner in the headline but does not give their
  // SteamID: creator_id on a trade confirmation is the trade offer id. So the
  // link opens the reputation tool with the name carried over, rather than
  // pretending to deep-link to a profile we cannot identify.
  if (conf.kind === 'trade' && conf.headline.trim()) {
    const partner = conf.headline.trim();
    const rep = document.createElement('a');
    rep.className = 'conf__rep';
    rep.href = `https://nohax.club/rep?q=${encodeURIComponent(partner)}`;
    rep.target = '_blank';
    rep.rel = 'noreferrer noopener';
    rep.title = `Look up ${partner} on nohax.club`;
    rep.textContent = 'Check this trader';
    // The name goes to the clipboard on the way out, so it can be pasted
    // straight into the search box.
    rep.addEventListener('click', () => {
      void navigator.clipboard?.writeText(partner).catch(() => {});
    });
    meta.append(rep);
  }

  body.append(meta);
  card.append(body);

  const actions = document.createElement('div');
  actions.className = 'conf__actions';

  const deny = document.createElement('button');
  deny.className = 'btn btn--danger btn--sm';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => respond(conf, 'deny', card));

  const accept = document.createElement('button');
  accept.className = 'btn btn--primary btn--sm';
  accept.textContent = 'Accept';
  accept.addEventListener('click', () => respond(conf, 'accept', card));

  actions.append(deny, accept);
  card.append(actions);
  return card;
}

async function respond(
  conf: ConfirmationView,
  decision: 'accept' | 'deny',
  card: HTMLElement,
): Promise<void> {
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  try {
    await post(`/accounts/${state.activeId}/confirmations/${conf.id}`, {
      decision,
      nonce: conf.nonce,
    });
    card.classList.add('is-leaving');
    setTimeout(() => {
      state.confirmations = state.confirmations.filter((c) => c.id !== conf.id);
      state.counts.set(state.activeId, state.confirmations.length);
      transition(() => {
        renderConfirmations(state.confirmations);
        renderAccounts();
      });
    }, 260);
    toast(decision === 'accept' ? 'Accepted.' : 'Denied.');
  } catch (err) {
    for (const button of card.querySelectorAll('button')) button.disabled = false;
    toast(message(err), 'error');
  }
}

function askBulk(decision: 'accept' | 'deny', count: number): Promise<boolean> {
  const d = dialog('bulk-dialog');
  const verb = decision === 'accept' ? 'Accept' : 'Deny';

  $('bulk-title').textContent = `${verb} all ${count}?`;
  $('bulk-text').textContent =
    decision === 'accept'
      ? 'Steam will complete every trade and listing in this list. Check the trade partners first if anything looks unfamiliar.'
      : 'Steam will cancel every trade and listing in this list.';

  const go = $('bulk-go') as HTMLButtonElement;
  go.textContent = `${verb} all`;
  go.className = `btn btn--sm ${decision === 'accept' ? 'btn--primary' : 'btn--danger'}`;

  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'go'), { once: true });
  });
}

async function respondAll(decision: 'accept' | 'deny'): Promise<void> {
  const count = state.confirmations.length;
  if (count === 0) return;
  if (!(await askBulk(decision, count))) return;

  try {
    await post(`/accounts/${state.activeId}/confirmations/batch`, { decision });
    toast(`${decision === 'accept' ? 'Accepted' : 'Denied'} ${count}.`);
    await loadConfirmations();
  } catch (err) {
    toast(message(err), 'error');
  }
}

$('accept-all').addEventListener('click', () => respondAll('accept'));
$('deny-all').addEventListener('click', () => respondAll('deny'));
$('refresh-btn').addEventListener('click', () => void loadConfirmations());

async function loadConfirmations(): Promise<void> {
  const account = activeAccount();
  if (!account) return;

  if (!account.canConfirm || !account.signedIn) {
    state.confirmations = [];
    renderConfirmations([]);
    return;
  }

  $('confirms').innerHTML = '<div class="skeleton"></div>';
  try {
    const { confirmations } = await api<{ confirmations: ConfirmationView[] }>(
      `/accounts/${account.id}/confirmations`,
    );
    state.confirmations = confirmations;
    state.counts.set(account.id, confirmations.length);
    renderConfirmations(confirmations);
    renderAccounts();
  } catch (err) {
    $('confirms').innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty';
    const title = document.createElement('div');
    title.className = 'empty__title';
    title.textContent = 'Could not read confirmations.';
    const hint = document.createElement('div');
    hint.className = 'empty__hint';
    hint.textContent = message(err);
    box.append(title, hint);
    $('confirms').append(box);
  }
}

/* ------------------------------------------------------------ adding */

const openAdd = () => dialog('add-dialog').showModal();
$('add-btn').addEventListener('click', openAdd);

$('choose-import').addEventListener('click', () => {
  dialog('add-dialog').close();
  $('import-results').innerHTML = '';
  dialog('import-dialog').showModal();
});

$('choose-link').addEventListener('click', () => {
  dialog('add-dialog').close();
  resetLink();
  dialog('link-dialog').showModal();
});

/* ----------------------------------------------------------- importing */

const dropzone = $('dropzone');

dropzone.addEventListener('click', () => input('import-input').click());
input('import-input').addEventListener('change', (event) => {
  const files = (event.target as HTMLInputElement).files;
  if (files) void importFiles(Array.from(files));
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
  });
}
dropzone.addEventListener('drop', (event) => {
  const files = (event as DragEvent).dataTransfer?.files;
  if (files) void importFiles(Array.from(files));
});

async function importFiles(files: File[]): Promise<void> {
  const results = $('import-results');
  results.innerHTML = '<div class="skeleton skeleton--sm"></div>';

  try {
    const payload = await Promise.all(
      files.map(async (file) => ({ name: file.name, content: await file.text() })),
    );
    const outcome = await post<{
      imported: { name: string; account: string; notes: string[] }[];
      failed: { name: string; error: string }[];
    }>('/accounts/import', { files: payload });

    results.innerHTML = '';
    for (const row of outcome.imported) {
      const line = document.createElement('div');
      line.className = 'result result--ok';
      line.textContent = `${row.account} imported`;
      results.append(line);
      for (const note of row.notes) {
        const warn = document.createElement('div');
        warn.className = 'result result--warn';
        warn.textContent = note;
        results.append(warn);
      }
    }
    for (const row of outcome.failed) {
      const line = document.createElement('div');
      line.className = 'result result--bad';
      line.textContent = `${row.name}: ${row.error}`;
      results.append(line);
    }

    if (outcome.imported.length > 0) {
      toast(`Imported ${outcome.imported.length}.`);
      await loadAccounts();
    }
  } catch (err) {
    results.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'result result--bad';
    line.textContent = message(err);
    results.append(line);
  }
}

/* -------------------------------------------------------------- linking */

function resetLink(): void {
  state.linkPendingId = '';
  $('link-step-login').hidden = false;
  $('link-step-code').hidden = true;
  $('link-guard-field').hidden = true;
  $('link-error').hidden = true;
  input('link-account').value = '';
  input('link-password').value = '';
  input('link-guard').value = '';
  input('link-sms').value = '';
  input('link-confirmed').checked = false;
  ($('link-finalize') as HTMLButtonElement).disabled = true;
}

function linkError(text: string): void {
  const el = $('link-error');
  el.textContent = text;
  el.hidden = false;
}

$('link-step-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('link-login-submit') as HTMLButtonElement;
  $('link-error').hidden = true;
  button.disabled = true;

  try {
    if (!state.linkPendingId) {
      const started = await post<{
        pendingId: string;
        ready: boolean;
        guard?: string;
        sentTo?: string;
      }>('/link/login', {
        accountName: input('link-account').value.trim(),
        password: input('link-password').value,
      });
      state.linkPendingId = started.pendingId;

      if (!started.ready) {
        $('link-guard-field').hidden = false;
        $('link-guard-label').textContent =
          started.guard === 'email-code'
            ? `Code Steam emailed${started.sentTo ? ` to ${started.sentTo}` : ''}`
            : 'Steam Guard code';
        input('link-guard').focus();
        return;
      }
    } else {
      const answered = await post<{ ready: boolean; error?: string }>('/link/guard', {
        pendingId: state.linkPendingId,
        code: input('link-guard').value.trim(),
      });
      if (!answered.ready) return linkError(answered.error ?? 'Steam has not confirmed that yet.');
    }

    const begun = await post<{ revocationCode: string; phoneHint: string | null }>('/link/begin', {
      pendingId: state.linkPendingId,
    });

    $('link-revocation').textContent = begun.revocationCode;
    $('link-step-login').hidden = true;
    $('link-step-code').hidden = false;
    $('link-title').textContent = begun.phoneHint
      ? `Steam texted ${begun.phoneHint}`
      : 'Steam sent you a code';
  } catch (err) {
    linkError(message(err));
  } finally {
    button.disabled = false;
  }
});

input('link-confirmed').addEventListener('change', (event) => {
  ($('link-finalize') as HTMLButtonElement).disabled = !(event.target as HTMLInputElement).checked;
});

$('link-finalize').addEventListener('click', async () => {
  const button = $('link-finalize') as HTMLButtonElement;
  $('link-error').hidden = true;
  button.disabled = true;
  try {
    const done = await post<{ added: string }>('/link/finalize', {
      smsCode: input('link-sms').value.trim(),
    });
    dialog('link-dialog').close();
    toast(`${done.added} is now protected.`);
    await loadAccounts();
  } catch (err) {
    linkError(message(err));
    button.disabled = false;
  }
});

/* ------------------------------------------------------- signing in */

let loginTarget: AccountView | null = null;
let loginPendingId = '';

function openLogin(account: AccountView): void {
  loginTarget = account;
  loginPendingId = '';
  $('login-text').textContent = `Steam password for ${account.accountName}.`;
  $('login-guard-field').hidden = true;
  $('login-error').hidden = true;
  input('login-password').value = '';
  input('login-guard').value = '';
  dialog('login-dialog').showModal();
  setTimeout(() => input('login-password').focus(), 40);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!loginTarget) return;
  const button = $('login-submit') as HTMLButtonElement;
  $('login-error').hidden = true;
  button.disabled = true;

  try {
    if (loginPendingId) {
      const answered = await post<{ ready: boolean }>('/link/guard', {
        pendingId: loginPendingId,
        code: input('login-guard').value.trim(),
      });
      if (!answered.ready) throw new Error('Steam has not confirmed that yet.');
    } else {
      const result = await post<{
        ready: boolean;
        pendingId?: string;
        guard?: string;
        sentTo?: string;
      }>(`/accounts/${loginTarget.id}/login`, { password: input('login-password').value });

      if (!result.ready) {
        loginPendingId = result.pendingId ?? '';
        $('login-guard-field').hidden = false;
        $('login-guard-label').textContent =
          result.guard === 'email-code'
            ? `Code Steam emailed${result.sentTo ? ` to ${result.sentTo}` : ''}`
            : 'Steam Guard code';
        input('login-guard').focus();
        return;
      }
    }

    dialog('login-dialog').close();
    toast('Signed in.');
    await loadAccounts();
  } catch (err) {
    const el = $('login-error');
    el.textContent = message(err);
    el.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* -------------------------------------------------------- account menu */

$('account-menu-btn').addEventListener('click', () => {
  const account = activeAccount();
  if (!account) return;
  $('account-dialog-title').textContent = account.label;
  ($('act-revocation') as HTMLButtonElement).disabled = !account.hasRevocationCode;
  ($('act-unlink') as HTMLButtonElement).disabled = !account.hasRevocationCode;
  dialog('account-dialog').showModal();
});

$('act-login').addEventListener('click', () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (account) openLogin(account);
});

$('act-rename').addEventListener('click', async () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (!account) return;

  const label = await prompt({
    title: 'Rename',
    text: 'A label for your own list. Steam never sees it.',
    label: 'Name',
    value: account.label,
    confirmText: 'Save',
  });
  if (label === null) return;

  await api(`/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ label }) });
  await loadAccounts();
  toast('Renamed.');
});

$('act-revocation').addEventListener('click', async () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (!account) return;

  try {
    const { revocationCode } = await api<{ revocationCode: string }>(
      `/accounts/${account.id}/revocation`,
    );
    await prompt({
      title: 'Revocation code',
      text: 'This removes the authenticator from Steam. Keep it somewhere that is not this computer.',
      reveal: revocationCode,
      confirmText: 'Copy',
    });
    await copy(revocationCode, 'Revocation code');
  } catch (err) {
    toast(message(err), 'error');
  }
});

$('act-export').addEventListener('click', async () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (!account) return;

  try {
    const { filename, content } = await api<{ filename: string; content: string }>(
      `/accounts/${account.id}/export`,
    );
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast(`${filename} saved. It is not encrypted, so store it carefully.`);
  } catch (err) {
    toast(message(err), 'error');
  }
});

$('act-remove').addEventListener('click', async () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (!account) return;

  const sure = await confirmDanger(
    `Remove ${account.label}?`,
    'This drops the account from this vault. Steam keeps the authenticator, so export first if you have no other copy.',
    'Remove',
  );
  if (!sure) return;

  await api(`/accounts/${account.id}`, { method: 'DELETE' });
  state.activeId = '';
  await loadAccounts();
  toast('Removed from this vault.');
});

$('act-unlink').addEventListener('click', async () => {
  const account = activeAccount();
  dialog('account-dialog').close();
  if (!account) return;

  const sure = await confirmDanger(
    `Remove the authenticator from ${account.label}?`,
    'Steam puts the account back on emailed codes and this authenticator stops working. Trades are held for longer afterwards.',
    'Remove from Steam',
  );
  if (!sure) return;

  try {
    await post(`/accounts/${account.id}/unlink`, { scheme: 1 });
    state.activeId = '';
    await loadAccounts();
    toast('Steam removed the authenticator.');
  } catch (err) {
    toast(message(err), 'error');
  }
});

/* ------------------------------------------------------------ settings */

$('settings-btn').addEventListener('click', () => {
  const s = state.settings;
  if (!s) return;

  $('about-version').textContent = state.version ? `v${state.version}` : '';

  input('set-autocheck').checked = s.autoCheckConfirmations;
  input('set-interval').value = String(s.checkIntervalSeconds);
  input('set-notify').checked = s.notifyOnNewConfirmation;
  input('set-idle').value = String(s.lockAfterIdleMinutes);
  input('set-auto-enabled').checked = s.autoConfirm.enabled;
  input('set-auto-market').checked = s.autoConfirm.market;
  input('set-auto-trades').checked = s.autoConfirm.trades;
  area('set-auto-partners').value = s.autoConfirm.allowedPartners.join('\n');
  input('set-auto-max').value = String(s.autoConfirm.maxPerHour);
  input('set-auto-hold').value = String(s.autoConfirm.holdSeconds);
  $('settings-error').hidden = true;

  dialog('settings-dialog').showModal();
});

$('settings-save').addEventListener('click', async () => {
  const button = $('settings-save') as HTMLButtonElement;
  button.disabled = true;
  try {
    const settings = {
      autoCheckConfirmations: input('set-autocheck').checked,
      checkIntervalSeconds: Number(input('set-interval').value) || 30,
      notifyOnNewConfirmation: input('set-notify').checked,
      lockAfterIdleMinutes: Number(input('set-idle').value) || 0,
      autoConfirm: {
        enabled: input('set-auto-enabled').checked,
        market: input('set-auto-market').checked,
        trades: input('set-auto-trades').checked,
        allowedPartners: area('set-auto-partners')
          .value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        maxPerHour: Number(input('set-auto-max').value) || 25,
        holdSeconds: Number(input('set-auto-hold').value) || 0,
      },
    };

    const saved = await api<{ settings: Settings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
    state.settings = saved.settings;
    paintAutoChip();
    dialog('settings-dialog').close();
    toast('Settings saved.');
    openEventStream();
  } catch (err) {
    const el = $('settings-error');
    el.textContent = message(err);
    el.hidden = false;
  } finally {
    button.disabled = false;
  }
});

function paintAutoChip(): void {
  const chip = $('auto-chip');
  const rules = state.settings?.autoConfirm;
  if (!rules?.enabled) {
    chip.hidden = true;
    return;
  }
  const parts: string[] = [];
  if (rules.market) parts.push('market');
  if (rules.trades) parts.push('trades');
  chip.hidden = false;
  chip.textContent = `auto: ${parts.join(' + ') || 'nothing'}`;
}

/* ------------------------------------------------------- notifications */

async function askNotificationPermission(): Promise<void> {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      // A browser that refuses is fine. Toasts still work.
    }
  }
}

function notify(title: string, body: string): void {
  if (!state.settings?.notifyOnNewConfirmation) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'sda-confirmation' });
  } catch {
    // Some platforms refuse without a service worker. The toast already showed.
  }
}

/* -------------------------------------------------------------- events */

let events: EventSource | null = null;

function openEventStream(): void {
  events?.close();
  if (!state.settings?.autoCheckConfirmations) return;

  events = new EventSource(`/v1/events?token=${encodeURIComponent(token)}`);

  events.addEventListener('confirmation', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      account: string;
      label: string;
      confirmation: ConfirmationView;
    };
    const count = (state.counts.get(data.account) ?? 0) + 1;
    state.counts.set(data.account, count);
    renderAccounts();

    notify(`${data.label}: ${data.confirmation.kind}`, data.confirmation.headline);
    if (data.account === state.activeId) void loadConfirmations();
  });

  events.addEventListener('auto-confirmed', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { count: number };
    toast(`Approved ${data.count} automatically.`);
    void loadConfirmations();
  });

  events.addEventListener('signed-out', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { label: string };
    toast(`${data.label} signed out of Steam.`, 'error');
    void loadAccounts();
  });

  events.onerror = () => {
    // EventSource reconnects on its own. Nothing to do.
  };
}

/* -------------------------------------------------------- window chrome */

function wireWindowControls(): void {
  document.body.dataset['platform'] = shell?.platform ?? 'web';
  document.body.dataset['frameless'] = String(shell?.frameless ?? false);
  if (!shell?.frameless) return;

  $('win-min').addEventListener('click', () => shell.minimize());
  $('win-max').addEventListener('click', () => shell.toggleMaximize());
  $('win-close').addEventListener('click', () => shell.hide());
}

/* --------------------------------------------------------------- loops */

setInterval(paintCode, 250);

async function paintClock(): Promise<void> {
  try {
    const { offset } = await api<{ offset: number }>('/time');
    $('clock').textContent =
      offset === 0 ? 'clock synced' : `clock ${offset > 0 ? '+' : ''}${offset}s`;
  } catch {
    $('clock').textContent = '';
  }
}

wireWindowControls();
void boot();
void paintClock();
setInterval(() => void paintClock(), 5 * 60_000);
