import type { Translation } from '../types.ts';
import type { board as EN } from '../en/board.ts';

export const board: Translation<typeof EN> = {
  'board.gameMap': 'Игровая карта',
  'board.mapPreview': 'Карта (превью)',
  'board.expand': 'Карта во весь экран',
  'board.exitExpand': 'Свернуть карту (Esc)',
  'board.resetView': 'Сбросить вид (север вверху)',
  'board.centreMe': 'Показать меня',
  'board.wholeMap': 'Показать всю карту',
  'board.focusTitle': '{label} (двойной щелчок по столу вокруг карты)',
  'board.menuLabel': 'Действия для этой клетки',
};
