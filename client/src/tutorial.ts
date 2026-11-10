// "How to play" card on the home screen: a poster that opens the explainer video in a modal.
// The video is only fetched when it is opened; phones get the lighter 720p file.

import { h } from './dom.ts';
import { L, T } from './i18n.ts';
import { openLayer } from './profile.ts';
import { icon } from './ui.ts';

const POSTER = '/tutorial/poster.jpg';
const SMALL = '(max-width: 900px)';

function playMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tut-play-mark');
  svg.innerHTML = '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>';
  return svg;
}

function openVideo(): void {
  const src = matchMedia(SMALL).matches ? '/tutorial/alliance-720.mp4' : '/tutorial/alliance-1080.mp4';
  const video = h('video', { class: 'tut-video', src, poster: POSTER, controls: true, playsinline: true, preload: 'auto' }) as HTMLVideoElement;
  // A visible close button: phones have no Esc, and the sheet's backdrop is a thin strip.
  const close = h('button', { class: 'btn ghost small tut-close', type: 'button', 'aria-label': L('common.close'), title: L('common.close') }, icon('close'));
  const layer = openLayer({
    label: L('home.tutorial.title'),
    kind: 'modal',
    cls: 'tut-layer',
    content: h('div', { class: 'tut-frame' }, h('div', { class: 'tut-head' }, h('span', { class: 'tut-head-title' }, T('home.tutorial.title')), close), video),
    initialFocus: video,
    onClose: () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  });
  close.addEventListener('click', () => layer.close());
  void video.play().catch(() => undefined);
}

export function tutorialCard(): HTMLElement {
  const thumb = h(
    'button',
    { class: 'tut-thumb', type: 'button', 'aria-label': L('home.tutorial.watch'), onclick: openVideo },
    h('img', { src: POSTER, alt: '', loading: 'lazy', decoding: 'async' }),
    h('span', { class: 'tut-play' }, playMark()),
    h('span', { class: 'tut-duration' }, '2:56'),
  );
  return h(
    'section',
    { class: 'card tut-card' },
    thumb,
    h(
      'div',
      { class: 'tut-body' },
      h('p', { class: 'eyebrow' }, T('home.tutorial.eyebrow')),
      h('h2', { class: 'tut-title' }, T('home.tutorial.title')),
      h('p', { class: 'muted' }, T('home.tutorial.text')),
      h('button', { class: 'btn secondary', type: 'button', onclick: openVideo }, playMark(), T('home.tutorial.watch')),
      h('p', { class: 'tut-note' }, T('home.tutorial.note')),
    ),
  );
}
