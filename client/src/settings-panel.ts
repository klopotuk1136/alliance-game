// Game settings in the lobby: an editable form for the room's creator, a read-only
// summary for everyone else. The server re-validates every change.

import { COST_KINDS, actionCost, escalates, type CostKind } from '../../shared/costs.ts';
import { cellCount } from '../../shared/hex.ts';
import { effectiveSpawnDistance, SETTING_RULES, type GameSettings } from '../../shared/settings.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { icon, Segmented, Select, Stepper, type ListOption } from './ui.ts';
import { fmtDuration, L, onLang, t, T, type Key as TKey } from './i18n.ts';
import { browserZone, clockAt, instantToZoned, startAtText, zonedToInstant } from './lobby-time.ts';
import { LOBBY_MAX_AHEAD_MS, LOBBY_MIN_AHEAD_MS } from '../../shared/settings.ts';

type Key = keyof GameSettings;
/** The label key of a setting (also used to name settings in server errors). */
const labelKey = (key: Key): TKey => `set.${key}.label`;
type Value = string | number;
/** Settings fields plus the exact lobby end (not a setting: the room's deadline, sent as `lobbyEndsAt`). */
type FieldKey = Key | 'lobbyEndsAt';

interface Field {
  key: FieldKey;
  row: HTMLElement;
  get(): Value;
  set(v: Value): void;
  hint?: HTMLElement;
}

const MIN = 60;

/** Two lobby deadlines on the same minute (the date/time inputs round up to whole minutes). */
function sameMinute(a: Value, b: Value): boolean {
  if (a === '' || b === '') return a === b;
  return Math.ceil(Number(a) / 60_000) === Math.ceil(Number(b) / 60_000);
}
const HOUR = 3600;
const DAY = 86400;

/** "2 days", "6 hours", "30 minutes" — in the largest whole unit. */
export function formatDuration(sec: number): string {
  if (sec >= DAY && sec % DAY === 0) return t('unit.days', { n: sec / DAY });
  if (sec >= HOUR && sec % HOUR === 0) return t('unit.hours', { n: sec / HOUR });
  if (sec >= MIN && sec % MIN === 0) return t('unit.minutes', { n: sec / MIN });
  return fmtDuration(sec);
}

function scheduleText(r: GameSettings): string {
  return r.tickMode === 'daily'
    ? t('set.sum.daily', { n: r.apPerTick, time: r.tickTime, zone: r.timezone })
    : t('set.sum.interval', { n: r.apPerTick, every: formatDuration(r.tickIntervalSec) });
}

const ACTION_NAMES: Record<CostKind, TKey> = { move: 'set.act.move', attack: 'set.act.attack', grant: 'set.act.grant', upgrade: 'set.act.upgrade' };

/** "attack 1, 2, 3… AP" (rising until the next AP) or "move 1 AP". */
function priceText(r: GameSettings, kind: CostKind): string {
  const first = actionCost(r, kind, 0);
  const action = t(ACTION_NAMES[kind]);
  if (!escalates(r, kind) || first === 0) return t('set.sum.price', { action, n: first });
  return t('set.sum.priceRising', { action, a: first, b: actionCost(r, kind, 1), c: actionCost(r, kind, 2) });
}

const REVEAL_TEXT: Record<GameSettings['revealActions'], TKey> = {
  hidden: 'set.reveal.hidden',
  attacks: 'set.reveal.attacks',
  all: 'set.reveal.all',
};

/** Unsaved form values ready to send, or the reason they can't be sent. */
export type PendingSettings = { changes: Record<string, string | number> } | { error: string };

function intRule(key: Key): { min: number; max: number } {
  const rule = SETTING_RULES[key];
  return rule.kind === 'int' ? { min: rule.min, max: rule.max } : { min: 0, max: 0 };
}

let zoneOptions: ListOption[] | null = null;

/** Every IANA time zone with its current UTC offset, for the searchable select. */
function timeZoneOptions(): ListOption[] {
  if (zoneOptions) return zoneOptions;
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['Europe/Berlin', 'Europe/London', 'Europe/Kyiv', 'America/New_York', 'UTC'];
  }
  if (!zones.includes('UTC')) zones.push('UTC');
  const now = new Date();
  zoneOptions = zones.map((z) => {
    let hint = '';
    try {
      hint = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      hint = '';
    }
    return { value: z, label: z.replace(/_/g, ' '), hint: hint === 'GMT' ? 'UTC' : hint.replace('GMT', 'UTC'), keywords: z };
  });
  return zoneOptions;
}

let fieldId = 0;

export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly onSave: (changes: Record<string, Value>) => void;
  private rules: GameSettings | null = null;
  private playerCount = 0;
  private mode: 'edit' | 'view' | null = null;
  private readonly fields = new Map<FieldKey, Field>();
  /** The room's saved lobby deadline (RoomView.lobbyEndsAt), and the one before the last update. */
  private endsAt: number | null = null;
  private prevEndsAt: number | null = null;
  /** The lobby mode the form showed at the last refresh (to prefill the time fields on a switch). */
  private shownLobbyMode: Value = '';
  private readonly body = h('div', { class: 'settings-body' });
  private readonly subtitle = h('p', { class: 'muted settings-sub' });
  private readonly saveBtn = h('button', { class: 'btn primary', type: 'submit' }, T('set.save'));
  private readonly discardBtn = h('button', { class: 'btn ghost', type: 'button' }, T('set.discard'));
  private readonly statusEl = h('span', { class: 'muted small' });
  /** Live map radius for the lobby preview: the creator's unsaved stepper value, else the saved one. */
  onRadiusPreview: (radius: number) => void = () => undefined;
  /** Called when the number of unsaved changes changes (the lobby's Start button reacts). */
  onDirtyChange: (count: number) => void = () => undefined;
  private lastDirty = -1;
  private saving = false;

  constructor(onSave: (changes: Record<string, Value>) => void) {
    this.onSave = onSave;
    // Text follows the language; the form (and its unsaved values) stays as it is.
    onLang(() => {
      if (!this.rules) return;
      if (this.mode === 'view') {
        this.subtitle.textContent = t('set.subView');
        this.renderSummary(this.rules);
      } else if (this.mode === 'edit') {
        this.subtitle.textContent = t('set.subEdit');
        this.refresh();
      }
    });
    this.discardBtn.addEventListener('click', () => this.discard());
    this.el = h(
      'section',
      { class: 'card framed settings-card' },
      h('div', { class: 'settings-head' }, h('h2', { class: 'card-title' }, T('set.title')), this.subtitle),
      this.body,
    );
  }

  update(rules: GameSettings, editable: boolean, playerCount: number, lobbyEndsAt: number | null = null): void {
    const previous = this.rules;
    this.prevEndsAt = this.endsAt;
    this.endsAt = lobbyEndsAt;
    this.rules = rules;
    this.playerCount = playerCount;
    const mode = editable ? 'edit' : 'view';
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'edit') this.buildForm();
    }
    if (mode === 'view') {
      this.subtitle.textContent = t('set.subView');
      this.renderSummary(rules);
      this.onRadiusPreview(rules.gridRadius);
    } else {
      this.subtitle.textContent = t('set.subEdit');
      this.syncForm(previous);
    }
  }

  // ---------------------------------------------------------------- read-only summary

  private renderSummary(r: GameSettings): void {
    const row = (label: string, value: string) => h('div', { class: 'summary-row' }, h('dt', null, label), h('dd', null, value));
    replaceChildren(
      this.body,
      h(
        'dl',
        { class: 'settings-summary' },
        row(t('set.sum.mode'), r.mode === 'blitz' ? t('set.sum.blitz', { turn: formatDuration(r.blitzTurnSec), ap: r.blitzApPerTurn, orders: r.blitzMaxOrders }) : t('set.sum.classic')),
        r.mode === 'blitz'
          ? row(t('set.sum.charge'), r.blitzChargeCap > 0 ? t('set.sum.chargeText', { cost: r.costCharge, cap: r.blitzChargeCap }) : t('set.sum.chargeOff'))
          : null,
        row(t('set.sum.players'), t('set.sum.upTo', { n: r.maxPlayers })),
        row(t('set.sum.map'), t('set.sum.radius', { r: r.gridRadius, n: cellCount(r.gridRadius) })),
        row(
          t('set.sum.spawn'),
          r.spawnMode === 'equidistant' ? t('set.sum.spawnRing', { n: effectiveSpawnDistance(r) }) : t('set.sum.spawnRandom', { n: effectiveSpawnDistance(r) }),
        ),
        row(t('set.sum.secrecy'), t(REVEAL_TEXT[r.revealActions])),
        row(t('set.sum.startWith'), t('set.sum.startStats', { hp: r.startHp, ap: r.startAp, range: r.startRange })),
        r.mode === 'blitz' ? null : row(t('set.sum.ap'), scheduleText(r)),
        row(t('set.sum.prices'), COST_KINDS.map((k) => priceText(r, k)).join(' · ')),
        row(t('set.sum.effects'), t('set.sum.effectsText', { dmg: r.attackDamage, gift: r.grantAmount, up: r.upgradeAmount })),
        COST_KINDS.some((k) => escalates(r, k)) ? row(t('set.sum.rising'), t('set.sum.risingText')) : null,
        row(t('set.sum.lobby'), r.lobbyMode === 'time' && this.endsAt !== null ? startAtText(this.endsAt, r).replace(/\.$/, '') : formatDuration(r.lobbyDurationSec)),
      ),
    );
  }

  // ---------------------------------------------------------------- editable form

  private row(key: Key, control: HTMLElement, id: string | null, wide = false, hint?: HTMLElement): HTMLElement {
    const label = T(labelKey(key));
    return h(
      'div',
      { class: `setting${wide ? ' wide' : ''}` },
      id ? h('label', { class: 'setting-label', for: id }, label) : h('span', { class: 'setting-label' }, label),
      control,
      hint ?? null,
    );
  }

  private numberField(key: Key): Field {
    const { min, max } = intRule(key);
    const stepper = new Stepper({ min, max, step: 1 });
    const id = `set-${++fieldId}`;
    stepper.input.id = id;
    const hint = h('span', { class: 'setting-hint' });
    const row = this.row(key, stepper.el, id, false, hint);
    return {
      key,
      row,
      hint,
      get: () => (stepper.value.trim() === '' ? '' : Number(stepper.value)),
      set: (v) => {
        stepper.value = String(v);
      },
    };
  }

  private durationField(key: Key, units: Array<[TKey, number]>): Field {
    const num = new Stepper({ min: 1, step: 1, decimal: true });
    const id = `set-${++fieldId}`;
    num.input.id = id;
    const unit = new Segmented<string>({
      label: L('set.unitOf', () => ({ label: t(labelKey(key)) })),
      options: units.map(([name, sec]) => ({ value: String(sec), label: T(name) })),
      cls: 'small',
    });
    const hint = h('span', { class: 'setting-hint' });
    const row = this.row(key, h('div', { class: 'duration' }, num.el, unit.el), id, true, hint);
    return {
      key,
      row,
      hint,
      get: () => (num.value.trim() === '' ? '' : Math.round(Number(num.value) * Number(unit.value))),
      set: (v) => {
        const sec = Number(v);
        const best = [...units].reverse().find(([, s]) => sec >= s && sec % s === 0) ?? units[0];
        unit.value = String(best[1]);
        num.value = String(sec / best[1]);
      },
    };
  }

  private segmentField(key: Key, options: Array<[string, TKey]>, withHint = false): Field {
    const seg = new Segmented<string>({ label: L(labelKey(key)), options: options.map(([value, text]) => ({ value, label: T(text) })), cls: 'block' });
    const hint = withHint ? h('span', { class: 'setting-hint' }) : undefined;
    const row = this.row(key, seg.el, null, true, hint);
    return {
      key,
      row,
      hint,
      get: () => seg.value,
      set: (v) => {
        seg.value = String(v);
      },
    };
  }

  private zoneField(key: Key): Field {
    const select = new Select<string>({
      label: L(labelKey(key)),
      options: timeZoneOptions(),
      searchable: true,
      searchPlaceholder: t('set.searchZones'),
      minWidth: 280,
      cls: 'block',
    });
    const row = this.row(key, select.el, null, true);
    return {
      key,
      row,
      get: () => select.value,
      set: (v) => {
        const z = String(v);
        const opts = timeZoneOptions();
        if (!opts.some((o) => o.value === z)) select.setOptions([...opts, { value: z, label: z }]);
        select.value = z;
      },
    };
  }

  private textField(key: Key, attrs: Record<string, string>): Field {
    const id = `set-${++fieldId}`;
    const input = h('input', { required: true, id, ...attrs });
    const row = this.row(key, h('div', { class: 'input-icon' }, icon('clock'), input), id, true);
    return {
      key,
      row,
      get: () => input.value.trim(),
      set: (v) => {
        input.value = String(v);
      },
    };
  }

  private buildForm(): void {
    this.fields.clear();
    const add = (f: Field): HTMLElement => {
      this.fields.set(f.key, f);
      return f.row;
    };
    const group = (title: TKey, ...rows: HTMLElement[]) =>
      h('fieldset', { class: 'setting-group' }, h('legend', null, T(title)), ...rows);
    const fixedRising: Array<[string, TKey]> = [
      ['off', 'set.opt.fixed'],
      ['on', 'set.opt.rising'],
    ];

    const groups = h(
      'div',
      { class: 'settings-grid' },
      group('set.g.mode', add(this.segmentField('mode', [['classic', 'set.opt.classic'], ['blitz', 'set.opt.blitz']], true))),
      group(
        'set.g.room',
        add(this.numberField('maxPlayers')),
        add(this.segmentField('lobbyMode', [['duration', 'set.opt.afterDuration'], ['time', 'set.opt.atTime']])),
        add(this.durationField('lobbyDurationSec', [['set.u.min', MIN], ['set.u.hours', HOUR], ['set.u.days', DAY]])),
        add(this.zoneField('lobbyZone')),
        add(this.lobbyEndField()),
        add(this.segmentField('revealActions', [['hidden', 'set.opt.secret'], ['attacks', 'set.opt.attacks'], ['all', 'set.opt.everything']], true)),
      ),
      group(
        'set.g.map',
        add(this.numberField('gridRadius')),
        add(this.numberField('minSpawnDistance')),
        add(this.segmentField('spawnMode', [['random', 'set.opt.random'], ['equidistant', 'set.opt.ring']], true)),
      ),

      group(
        'set.g.blitz',
        add(this.durationField('blitzTurnSec', [['set.u.sec', 1], ['set.u.min', MIN]])),
        add(this.numberField('blitzApPerTurn')),
        add(this.numberField('blitzMaxOrders')),
        add(this.numberField('blitzChargeCap')),
        add(this.numberField('costCharge')),
      ),
      group('set.g.start', add(this.numberField('startHp')), add(this.numberField('startAp')), add(this.numberField('startRange'))),
      group(
        'set.g.schedule',
        add(this.segmentField('tickMode', [['daily', 'set.opt.daily'], ['interval', 'set.opt.interval']])),
        add(this.textField('tickTime', { type: 'time' })),
        add(this.zoneField('timezone')),
        add(this.durationField('tickIntervalSec', [['set.u.sec', 1], ['set.u.min', MIN], ['set.u.hours', HOUR]])),
        add(this.numberField('apPerTick')),
      ),
    );
    const advanced = h(
      'details',
      { class: 'settings-advanced' },
      h('summary', null, h('span', { class: 'acc-title' }, T('set.advTitle')), h('span', { class: 'acc-sub' }, T('set.advSub')), icon('chevron', 'acc-chevron')),
      h(
        'div',
        { class: 'settings-grid acc-body' },
        group(
          'set.g.costs',
          add(this.numberField('costMove')),
          add(this.numberField('costAttack')),
          add(this.numberField('costGrant')),
          add(this.numberField('costUpgrade')),
        ),
        group(
          'set.g.rising',
          add(this.segmentField('escalateAttack', fixedRising)),
          add(this.segmentField('escalateGrant', fixedRising)),
          add(this.segmentField('escalateMove', fixedRising)),
          add(this.segmentField('escalateUpgrade', fixedRising, true)),
        ),
        group('set.g.effects', add(this.numberField('attackDamage')), add(this.numberField('grantAmount')), add(this.numberField('upgradeAmount'))),
      ),
    );
    const form = h('form', { class: 'settings-form', novalidate: true }, groups, advanced, h('div', { class: 'settings-actions' }, this.saveBtn, this.discardBtn, this.statusEl));
    form.addEventListener('input', () => this.refresh());
    form.addEventListener('change', () => this.refresh());
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.save();
    });
    replaceChildren(this.body, form);
    for (const f of this.fields.values()) if (this.rules) f.set(this.savedOf(f.key, this.rules, this.endsAt));
    this.shownLobbyMode = this.value('lobbyMode');
    this.refresh();
  }

  /** The saved value behind a field. */
  private savedOf(key: FieldKey, rules: GameSettings, endsAt: number | null): Value {
    if (key === 'lobbyEndsAt') return endsAt ?? '';
    return rules[key];
  }

  private isDirty(f: Field): boolean {
    if (!this.rules) return false;
    if (f.key === 'lobbyEndsAt') {
      // Only an exact start counts, compared to the minute (the inputs have no seconds).
      if (this.value('lobbyMode') !== 'time') return false;
      const v = f.get();
      const saved = this.endsAt;
      if (v === '' || saved === null) return v !== '';
      return !sameMinute(v, saved);
    }
    return String(f.get()) !== String(this.rules[f.key]);
  }

  /** Copies new saved values into every field the creator hasn't edited (value still equals the old saved one). */
  private syncForm(previous: GameSettings | null): void {
    if (!this.rules) return;
    for (const f of this.fields.values()) {
      const old = previous ? this.savedOf(f.key, previous, this.prevEndsAt) : '';
      const untouched = !previous || (f.key === 'lobbyEndsAt' ? sameMinute(f.get(), old) : String(f.get()) === String(old));
      if (untouched) f.set(this.savedOf(f.key, this.rules, this.endsAt));
    }
    this.refresh();
  }

  private discard(): void {
    if (!this.rules) return;
    for (const f of this.fields.values()) f.set(this.savedOf(f.key, this.rules, this.endsAt));
    this.refresh();
  }

  /** The exact start: a date and a time on the clock of the lobbyZone field. */
  private lobbyEndField(): Field {
    const id = `set-${++fieldId}`;
    const date = h('input', { id, type: 'date', class: 'lobby-date', required: true });
    const time = h('input', { type: 'time', class: 'lobby-time', required: true, 'aria-label': L('set.lobbyEndsAt.label') });
    const hint = h('span', { class: 'setting-hint' });
    const zone = (): string => String(this.value('lobbyZone') || browserZone());
    const row = h(
      'div',
      { class: 'setting wide lobby-at' },
      h('label', { class: 'setting-label', for: id }, T('set.lobbyEndsAt.label')),
      h('div', { class: 'lobby-at-inputs' }, date, time),
      hint,
    );
    return {
      key: 'lobbyEndsAt',
      row,
      hint,
      get: () => {
        const at = zonedToInstant(date.value, time.value, zone());
        return Number.isFinite(at) ? at : '';
      },
      set: (v) => {
        const at = Number(v);
        if (v === '' || !Number.isFinite(at)) {
          date.value = '';
          time.value = '';
          return;
        }
        // Rounded up to the minute: the inputs have no seconds.
        const z = instantToZoned(Math.ceil(at / 60_000) * 60_000, zone());
        date.value = z.date;
        time.value = z.time;
      },
    };
  }

  private value(key: FieldKey): Value {
    return this.fields.get(key)?.get() ?? '';
  }

  /** Updates hints, conditional rows and the save button after any edit. */
  private refresh(): void {
    if (!this.rules) return;
    // Lobby: a length, or an exact start in a chosen time zone (the creator's own by default).
    const atTime = this.value('lobbyMode') === 'time';
    if (atTime && this.shownLobbyMode !== 'time' && this.rules.lobbyMode !== 'time') {
      this.fields.get('lobbyZone')?.set(browserZone());
      const soon = Math.ceil((Date.now() + 3600_000) / 3600_000) * 3600_000;
      this.fields.get('lobbyEndsAt')?.set(this.endsAt !== null && this.endsAt > Date.now() + LOBBY_MIN_AHEAD_MS ? this.endsAt : soon);
    }
    this.shownLobbyMode = this.value('lobbyMode');
    this.fields.get('lobbyDurationSec')!.row.hidden = atTime;
    this.fields.get('lobbyZone')!.row.hidden = !atTime;
    this.fields.get('lobbyEndsAt')!.row.hidden = !atTime;
    const endField = this.fields.get('lobbyEndsAt');
    if (endField?.hint) {
      const at = Number(endField.get());
      const ok = endField.get() !== '' && at >= Date.now() + LOBBY_MIN_AHEAD_MS && at <= Date.now() + LOBBY_MAX_AHEAD_MS;
      // The viewer's own clock only when it differs from the chosen zone's.
      const zone = String(this.value('lobbyZone'));
      const differs = ok && clockAt(at) !== clockAt(at, zone);
      endField.hint.textContent = !ok ? t('set.hint.pickTime') : differs ? t('set.hint.yourTime', { time: clockAt(at) }) : '';
      endField.row.classList.toggle('invalid', !ok && atTime);
    }
    // Blitz: its own group instead of the AP schedule (turns bring the AP)
    const blitz = this.value('mode') === 'blitz';
    const groupOf = (key: Key): HTMLFieldSetElement | null | undefined => this.fields.get(key)?.row.closest('fieldset');
    const blitzGroup = groupOf('blitzTurnSec');
    if (blitzGroup) blitzGroup.hidden = !blitz;
    const scheduleGroup = groupOf('tickMode');
    if (scheduleGroup) scheduleGroup.hidden = blitz;
    const modeHint = this.fields.get('mode')?.hint;
    if (modeHint) modeHint.textContent = t(blitz ? 'set.hint.blitz' : 'set.hint.classic');
    const turnHint = this.fields.get('blitzTurnSec')?.hint;
    if (turnHint) turnHint.textContent = t('set.hint.turn');
    const capHint = this.fields.get('blitzChargeCap')?.hint;
    if (capHint) capHint.textContent = t('set.hint.chargeCap');
    const daily = this.value('tickMode') === 'daily';
    this.fields.get('tickTime')!.row.hidden = !daily;
    this.fields.get('timezone')!.row.hidden = !daily;
    this.fields.get('tickIntervalSec')!.row.hidden = daily;

    const radius = Number(this.value('gridRadius'));
    const setHint = (key: Key, text: string) => {
      const hint = this.fields.get(key)?.hint;
      if (hint) hint.textContent = text;
    };
    setHint('gridRadius', Number.isFinite(radius) && radius > 0 ? t('unit.cells', { n: cellCount(radius) }) : '');
    const { min: rMin, max: rMax } = intRule('gridRadius');
    this.onRadiusPreview(Number.isInteger(radius) && radius >= rMin && radius <= rMax ? radius : this.rules.gridRadius);
    const range = Number(this.value('startRange'));
    setHint('minSpawnDistance', Number.isFinite(range) ? t('set.hint.autoDistN', { n: range + 1 }) : t('set.hint.autoDist'));
    setHint('maxPlayers', t('set.hint.joined', { n: this.playerCount }));
    setHint('lobbyDurationSec', t('set.hint.lobby'));
    setHint('spawnMode', this.value('spawnMode') === 'equidistant' ? t('set.hint.ring') : t('set.hint.random'));
    const reveal = this.value('revealActions') as GameSettings['revealActions'];
    setHint('revealActions', REVEAL_TEXT[reveal] ? t(REVEAL_TEXT[reveal]) : '');
    setHint('escalateUpgrade', t('set.hint.rising'));

    const dirty = [...this.fields.values()].filter((f) => this.isDirty(f));
    for (const f of this.fields.values()) f.row.classList.toggle('dirty', this.isDirty(f));
    this.saveBtn.disabled = dirty.length === 0;
    this.body.firstElementChild?.classList.toggle('is-dirty', dirty.length > 0);
    this.discardBtn.hidden = dirty.length === 0;
    this.statusEl.textContent = this.saving ? t('set.saving') : dirty.length ? t('set.unsaved', { n: dirty.length }) : t('set.allSaved');
    this.el.classList.toggle('has-unsaved', dirty.length > 0);
    if (dirty.length !== this.lastDirty) {
      this.lastDirty = dirty.length;
      this.onDirtyChange(dirty.length);
    }
  }

  /** How many fields differ from the saved settings (0 for viewers). */
  get dirtyCount(): number {
    if (this.mode !== 'edit') return 0;
    return [...this.fields.values()].filter((f) => this.isDirty(f)).length;
  }

  /** The unsaved changes to send (with Save or with Start), or why they can't be sent. */
  pending(): PendingSettings {
    const changes: Record<string, Value> = {};
    if (this.mode !== 'edit') return { changes };
    for (const f of this.fields.values()) {
      if (!this.isDirty(f)) continue;
      const v = f.get();
      if (v === '' || (typeof v === 'number' && !Number.isFinite(v))) return { error: t('set.fillAll') };
      if (f.key === 'lobbyEndsAt' && (Number(v) < Date.now() + LOBBY_MIN_AHEAD_MS || Number(v) > Date.now() + LOBBY_MAX_AHEAD_MS)) return { error: t('set.hint.pickTime') };
      changes[f.key] = v;
    }
    return { changes };
  }

  /** Brings the form into view and marks it, e.g. when Start was refused because of it. */
  reveal(): void {
    this.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
  }

  private save(): void {
    const pending = this.pending();
    if ('error' in pending) {
      toast(pending.error, 'error');
      return;
    }
    const changes = pending.changes;
    if (Object.keys(changes).length) {
      this.saving = true;
      this.statusEl.textContent = t('set.saving');
      this.onSave(changes);
      // If the server refuses (it shows an error toast), fall back to the unsaved-changes status.
      setTimeout(() => {
        this.saving = false;
        this.refresh();
      }, 1500);
    }
  }
}
