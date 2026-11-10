// Long-press feedback: a thin brass ring that fills around the finger while a press is
// held on a board cell (both boards use it). Pure CSS animation, removed when the press
// ends; `fired` lets it close with a short pop instead of fading out.

export const LONG_PRESS_MS = 450;

export interface PressRing {
  end(fired: boolean): void;
}

export function pressRing(x: number, y: number): PressRing {
  const el = document.createElement('div');
  el.className = 'press-ring';
  el.setAttribute('aria-hidden', 'true');
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--press-ms', `${LONG_PRESS_MS}ms`);
  document.body.appendChild(el);
  let done = false;
  return {
    end(fired: boolean): void {
      if (done) return;
      done = true;
      el.classList.add(fired ? 'fired' : 'cancel');
      setTimeout(() => el.remove(), fired ? 260 : 140);
    },
  };
}
