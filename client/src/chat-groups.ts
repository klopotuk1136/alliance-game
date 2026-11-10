// Dialogs for group chats: pick members (new group / add members), rename, and a small
// confirm. They use the shared layer (modal on desktop, bottom sheet on phones).

import type { PublicPlayer } from '../../shared/protocol.ts';
import { GROUP_NAME_MAX } from '../../shared/plan.ts';
import { flagImg, h } from './dom.ts';
import { L, onLang, t, T } from './i18n.ts';
import { openLayer } from './profile.ts';
import { icon } from './ui.ts';

/** "Anna, Boris and Carol" style list of names, for a group without a custom name. */
export function namesList(names: string[]): string {
  if (names.length === 0) return t('chat.justYou');
  if (names.length <= 3) return names.join(', ');
  return t('chat.namesMore', { names: names.slice(0, 2).join(', '), n: names.length - 2 });
}

function dialogShell(title: Node | string, body: Array<Node | null>, foot: Node[]): { form: HTMLFormElement; close: HTMLButtonElement } {
  const close = h('button', { class: 'btn ghost small pf-x', type: 'button', 'aria-label': L('chat.close') }, icon('close'));
  const form = h(
    'form',
    { class: 'grp-dialog', novalidate: true },
    h('header', { class: 'grp-dialog-head' }, h('h2', { class: 'grp-dialog-title' }, title), close),
    h('div', { class: 'grp-dialog-body' }, body),
    h('footer', { class: 'grp-dialog-foot' }, foot),
  );
  return { form, close };
}

/**
 * Pick players: for a new group (name + at least two others) or to add members to one.
 * `onSubmit` gets the typed name ('' = members' names) and the chosen pids.
 */
export function openMembersDialog(o: {
  mode: 'create' | 'add';
  candidates: PublicPlayer[];
  onSubmit: (name: string, pids: number[]) => void;
}): void {
  const chosen = new Set<number>();
  const min = o.mode === 'create' ? 2 : 1;
  const nameInput = h('input', { id: 'grp-name', maxlength: GROUP_NAME_MAX, autocomplete: 'off', spellcheck: 'false', placeholder: t('chat.membersNames') });
  const hint = h('p', { class: 'grp-hint', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, icon(o.mode === 'create' ? 'users' : 'plus'), T(o.mode === 'create' ? 'chat.createGroup' : 'chat.addToGroup'));
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, T('chat.cancel'));

  const players = [...o.candidates].sort((a, b) => a.nickname.localeCompare(b.nickname));
  const rows = players.map((p) => {
    const box = h('input', { type: 'checkbox', class: 'grp-check', value: String(p.pid) });
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(p.pid);
      else chosen.delete(p.pid);
      sync();
    });
    return h(
      'label',
      { class: `grp-pick ${p.alive ? '' : 'out'}`.trim() },
      box,
      h('span', { class: 'grp-tick', 'aria-hidden': 'true' }, icon('check')),
      flagImg(p.flag),
      h('span', { class: 'grp-pick-name' }, p.nickname),
      p.alive ? null : h('span', { class: 'grp-pick-out' }, T('chat.out')),
    );
  });

  function sync(): void {
    const n = chosen.size;
    submit.disabled = n < min;
    if (o.mode === 'create') {
      hint.textContent = n < min ? t('chat.hintPickTwo') : t('chat.hintMembersOnly');
      const names = players.filter((p) => chosen.has(p.pid)).map((p) => p.nickname);
      nameInput.placeholder = names.length ? namesList(names) : t('chat.membersNames');
    } else {
      hint.textContent = t('chat.hintAddHistory');
    }
  }

  const body: Array<Node | null> = [
    o.mode === 'create'
      ? h('div', { class: 'grp-field' }, h('label', { class: 'field-label', for: 'grp-name' }, T('chat.groupNameOptional')), nameInput)
      : null,
    h('fieldset', { class: 'grp-picks' }, h('legend', { class: 'field-label' }, T(o.mode === 'create' ? 'chat.members' : 'chat.addPlayers')), rows.length ? rows : h('p', { class: 'grp-hint' }, T('chat.allInGroup'))),
    hint,
  ];
  const { form, close } = dialogShell(T(o.mode === 'create' ? 'chat.newGroupTitle' : 'chat.addMembersTitle'), body, [cancel, submit]);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (chosen.size < min) return;
    o.onSubmit(nameInput.value.trim(), [...chosen]);
    layer.close();
  });
  sync();
  const offLang = onLang(sync);
  const layer = openLayer({
    label: t(o.mode === 'create' ? 'chat.newGroupTitle' : 'chat.addMembersTitle'),
    content: form,
    kind: 'modal',
    cls: 'grp-layer',
    initialFocus: o.mode === 'create' ? nameInput : null,
    onClose: () => offLang(),
  });
  close.addEventListener('click', () => layer.close());
  cancel.addEventListener('click', () => layer.close());
}

/** Rename a group; an empty name goes back to the members' names. */
export function openRenameDialog(current: string, fallback: string, onSubmit: (name: string) => void): void {
  const input = h('input', { id: 'grp-rename', maxlength: GROUP_NAME_MAX, autocomplete: 'off', spellcheck: 'false', placeholder: fallback });
  input.value = current;
  const submit = h('button', { class: 'btn primary', type: 'submit' }, icon('check'), T('chat.saveName'));
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, T('chat.cancel'));
  const { form, close } = dialogShell(
    T('chat.renameTitle'),
    [h('div', { class: 'grp-field' }, h('label', { class: 'field-label', for: 'grp-rename' }, T('chat.groupName')), input), h('p', { class: 'grp-hint' }, T('chat.renameHint'))],
    [cancel, submit],
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onSubmit(input.value.trim());
    layer.close();
  });
  const layer = openLayer({ label: t('chat.renameTitle'), content: form, kind: 'modal', cls: 'grp-layer', initialFocus: input });
  close.addEventListener('click', () => layer.close());
  cancel.addEventListener('click', () => layer.close());
}

/** A yes/no question. */
export function confirmDialog(o: { title: string; text: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const yes = h('button', { class: `btn ${o.danger ? 'danger' : 'primary'}`, type: 'submit' }, o.confirm);
    const no = h('button', { class: 'btn ghost', type: 'button' }, T('chat.cancel'));
    const { form, close } = dialogShell(o.title, [h('p', { class: 'grp-text' }, o.text)], [no, yes]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      answered = true;
      resolve(true);
      layer.close();
    });
    const layer = openLayer({
      label: o.title,
      content: form,
      kind: 'modal',
      cls: 'grp-layer small',
      initialFocus: yes,
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    close.addEventListener('click', () => layer.close());
    no.addEventListener('click', () => layer.close());
  });
}
