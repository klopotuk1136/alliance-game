// Game settings in the lobby: an editable form for the room's creator, a read-only
// summary for everyone else. The server re-validates every change.

import { cellCount } from '../../shared/hex.ts';
import { effectiveSpawnDistance, SETTING_RULES, type GameSettings } from '../../shared/settings.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { icon, Segmented, Select, Stepper, type ListOption } from './ui.ts';

type Key = keyof GameSettings;
type Value = string | number;

interface Field {
  key: Key;
  row: HTMLElement;
  get(): Value;
  set(v: Value): void;
  hint?: HTMLElement;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

export function formatDuration(sec: number): string {
  if (sec >= DAY && sec % DAY === 0) return `${sec / DAY} ${sec === DAY ? 'day' : 'days'}`;
  if (sec >= HOUR && sec % HOUR === 0) return `${sec / HOUR} h`;
  if (sec >= MIN && sec % MIN === 0) return `${sec / MIN} min`;
  return `${sec} s`;
}

function scheduleText(r: GameSettings): string {
  const amount = `+${r.apPerTick} AP`;
  return r.tickMode === 'daily' ? `${amount} every day at ${r.tickTime} (${r.timezone})` : `${amount} every ${formatDuration(r.tickIntervalSec)}`;
}

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
  private readonly fields = new Map<Key, Field>();
  private readonly body = h('div', { class: 'settings-body' });
  private readonly subtitle = h('p', { class: 'muted settings-sub' });
  private readonly saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save settings');
  private readonly discardBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Discard');
  private readonly statusEl = h('span', { class: 'muted small' });
  /** Live map radius for the lobby preview: the creator's unsaved stepper value, else the saved one. */
  onRadiusPreview: (radius: number) => void = () => undefined;

  constructor(onSave: (changes: Record<string, Value>) => void) {
    this.onSave = onSave;
    this.discardBtn.addEventListener('click', () => this.discard());
    this.el = h(
      'section',
      { class: 'card framed settings-card' },
      h('div', { class: 'settings-head' }, h('h2', { class: 'card-title' }, 'Game settings'), this.subtitle),
      this.body,
    );
  }

  update(rules: GameSettings, editable: boolean, playerCount: number): void {
    const previous = this.rules;
    this.rules = rules;
    this.playerCount = playerCount;
    const mode = editable ? 'edit' : 'view';
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'edit') this.buildForm();
    }
    if (mode === 'view') {
      this.subtitle.textContent = 'Set by the room creator. They can change these until the game starts.';
      this.renderSummary(rules);
      this.onRadiusPreview(rules.gridRadius);
    } else {
      this.subtitle.textContent = 'Only you can change these, until the game starts. Everyone in the lobby sees them.';
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
        row('Players', `up to ${r.maxPlayers}`),
        row('Map', `radius ${r.gridRadius} (${cellCount(r.gridRadius)} cells)`),
        row('Spawn', `at least ${effectiveSpawnDistance(r)} cells apart`),
        row('Start with', `${r.startHp} HP · ${r.startAp} AP · range ${r.startRange}`),
        row('AP', scheduleText(r)),
        row(
          'Actions',
          `move ${r.costMove} AP · attack ${r.costAttack} AP (−${r.attackDamage} HP) · give AP ${r.costGrant} AP (+${r.grantAmount}) · range +${r.upgradeAmount} for ${r.costUpgrade} AP`,
        ),
        row('Lobby', formatDuration(r.lobbyDurationSec)),
      ),
    );
  }

  // ---------------------------------------------------------------- editable form

  private row(label: string, control: HTMLElement, id: string | null, wide = false, hint?: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: `setting${wide ? ' wide' : ''}` },
      id ? h('label', { class: 'setting-label', for: id }, label) : h('span', { class: 'setting-label' }, label),
      control,
      hint ?? null,
    );
  }

  private numberField(key: Key, label: string): Field {
    const { min, max } = intRule(key);
    const stepper = new Stepper({ min, max, step: 1 });
    const id = `set-${++fieldId}`;
    stepper.input.id = id;
    const hint = h('span', { class: 'setting-hint' });
    const row = this.row(label, stepper.el, id, false, hint);
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

  private durationField(key: Key, label: string, units: Array<[string, number]>): Field {
    const num = new Stepper({ min: 1, step: 1, decimal: true });
    const id = `set-${++fieldId}`;
    num.input.id = id;
    const unit = new Segmented<string>({
      label: `${label} unit`,
      options: units.map(([name, sec]) => ({ value: String(sec), label: name })),
      cls: 'small',
    });
    const hint = h('span', { class: 'setting-hint' });
    const row = this.row(label, h('div', { class: 'duration' }, num.el, unit.el), id, true, hint);
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

  private segmentField(key: Key, label: string, options: Array<[string, string]>): Field {
    const seg = new Segmented<string>({ label, options: options.map(([value, text]) => ({ value, label: text })), cls: 'block' });
    const row = this.row(label, seg.el, null, true);
    return {
      key,
      row,
      get: () => seg.value,
      set: (v) => {
        seg.value = String(v);
      },
    };
  }

  private zoneField(key: Key, label: string): Field {
    const select = new Select<string>({
      label,
      options: timeZoneOptions(),
      searchable: true,
      searchPlaceholder: 'Search time zones…',
      minWidth: 280,
      cls: 'block',
    });
    const row = this.row(label, select.el, null, true);
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

  private textField(key: Key, label: string, attrs: Record<string, string>): Field {
    const id = `set-${++fieldId}`;
    const input = h('input', { required: true, id, ...attrs });
    const row = this.row(label, h('div', { class: 'input-icon' }, icon('clock'), input), id, true);
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
    const group = (title: string, ...rows: HTMLElement[]) =>
      h('fieldset', { class: 'setting-group' }, h('legend', null, title), ...rows);

    const groups = h(
      'div',
      { class: 'settings-grid' },
      group(
        'Room',
        add(this.numberField('maxPlayers', 'Max players')),
        add(this.durationField('lobbyDurationSec', 'Lobby length', [['min', MIN], ['hours', HOUR], ['days', DAY]])),
      ),
      group('Map', add(this.numberField('gridRadius', 'Map radius')), add(this.numberField('minSpawnDistance', 'Min spawn distance'))),
      group(
        'Starting stats',
        add(this.numberField('startHp', 'HP')),
        add(this.numberField('startAp', 'AP')),
        add(this.numberField('startRange', 'Attack range')),
      ),
      group(
        'AP schedule',
        add(this.segmentField('tickMode', 'Give AP', [['daily', 'Once a day'], ['interval', 'Fixed interval']])),
        add(this.textField('tickTime', 'Time of day', { type: 'time' })),
        add(this.zoneField('timezone', 'Time zone')),
        add(this.durationField('tickIntervalSec', 'Every', [['sec', 1], ['min', MIN], ['hours', HOUR]])),
        add(this.numberField('apPerTick', 'AP each time')),
      ),
    );
    const advanced = h(
      'details',
      { class: 'settings-advanced' },
      h('summary', null, h('span', { class: 'acc-title' }, 'Action costs and effects'), h('span', { class: 'acc-sub' }, 'AP prices, damage, grants and range'), icon('chevron', 'acc-chevron')),
      h(
        'div',
        { class: 'settings-grid acc-body' },
        group(
          'AP costs',
          add(this.numberField('costMove', 'Move')),
          add(this.numberField('costAttack', 'Attack')),
          add(this.numberField('costGrant', 'Give AP')),
          add(this.numberField('costUpgrade', 'Range upgrade')),
        ),
        group(
          'Effects',
          add(this.numberField('attackDamage', 'Damage per attack')),
          add(this.numberField('grantAmount', 'AP given per grant')),
          add(this.numberField('upgradeAmount', 'Range per upgrade')),
        ),
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
    for (const f of this.fields.values()) if (this.rules) f.set(this.rules[f.key]);
    this.refresh();
  }

  private isDirty(f: Field): boolean {
    return !!this.rules && String(f.get()) !== String(this.rules[f.key]);
  }

  /** Copies new saved values into every field the creator hasn't edited (value still equals the old saved one). */
  private syncForm(previous: GameSettings | null): void {
    if (!this.rules) return;
    for (const f of this.fields.values()) {
      if (!previous || String(f.get()) === String(previous[f.key])) f.set(this.rules[f.key]);
    }
    this.refresh();
  }

  private discard(): void {
    if (!this.rules) return;
    for (const f of this.fields.values()) f.set(this.rules[f.key]);
    this.refresh();
  }

  private value(key: Key): Value {
    return this.fields.get(key)?.get() ?? '';
  }

  /** Updates hints, conditional rows and the save button after any edit. */
  private refresh(): void {
    if (!this.rules) return;
    const daily = this.value('tickMode') === 'daily';
    this.fields.get('tickTime')!.row.hidden = !daily;
    this.fields.get('timezone')!.row.hidden = !daily;
    this.fields.get('tickIntervalSec')!.row.hidden = daily;

    const radius = Number(this.value('gridRadius'));
    const setHint = (key: Key, text: string) => {
      const hint = this.fields.get(key)?.hint;
      if (hint) hint.textContent = text;
    };
    setHint('gridRadius', Number.isFinite(radius) && radius > 0 ? `${cellCount(radius)} cells` : '');
    const { min: rMin, max: rMax } = intRule('gridRadius');
    this.onRadiusPreview(Number.isInteger(radius) && radius >= rMin && radius <= rMax ? radius : this.rules.gridRadius);
    const range = Number(this.value('startRange'));
    setHint('minSpawnDistance', `0 = automatic (range + 1${Number.isFinite(range) ? ` = ${range + 1}` : ''})`);
    setHint('maxPlayers', `${this.playerCount} joined so far`);
    setHint('lobbyDurationSec', 'counted from when the room opened');

    const dirty = [...this.fields.values()].filter((f) => this.isDirty(f));
    for (const f of this.fields.values()) f.row.classList.toggle('dirty', this.isDirty(f));
    this.saveBtn.disabled = dirty.length === 0;
    this.body.firstElementChild?.classList.toggle('is-dirty', dirty.length > 0);
    this.discardBtn.hidden = dirty.length === 0;
    this.statusEl.textContent = dirty.length ? `${dirty.length} unsaved ${dirty.length === 1 ? 'change' : 'changes'}` : 'All changes saved';
  }

  private save(): void {
    const changes: Record<string, Value> = {};
    for (const f of this.fields.values()) {
      if (!this.isDirty(f)) continue;
      const v = f.get();
      if (v === '' || (typeof v === 'number' && !Number.isFinite(v))) {
        toast('Fill in every field before saving', 'error');
        return;
      }
      changes[f.key] = v;
    }
    if (Object.keys(changes).length) {
      this.statusEl.textContent = 'Saving…';
      this.onSave(changes);
      // If the server refuses (it shows an error toast), fall back to the unsaved-changes status.
      setTimeout(() => this.refresh(), 1500);
    }
  }
}
