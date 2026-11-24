export interface OkidokiLoaderSquare {
  x: number;
  y: number;
}

export const OKIDOKI_LOADER_VIEW_BOX_SIZE = 360;
export const OKIDOKI_LOADER_OFFSET_X = 67.5;
export const OKIDOKI_LOADER_OFFSET_Y = 30;
export const OKIDOKI_LOADER_SQUARE_SIZE = 75;
export const OKIDOKI_LOADER_STAGGER_MS = 240;
export const OKIDOKI_LOADER_CYCLE_MS = 1_680;
export const OKIDOKI_LOADER_FADE_MS = 360;
export const OKIDOKI_LOADER_MIN_OPACITY = 0.46;
export const OKIDOKI_LOADER_MAX_OPACITY = 0.82;
export const OKIDOKI_LOADER_REDUCED_MOTION_OPACITY = 0.64;

export const OKIDOKI_LOADER_SQUARES: readonly OkidokiLoaderSquare[] = [
  { x: 0, y: 0 },
  { x: 75, y: 0 },
  { x: 150, y: 75 },
  { x: 0, y: 150 },
  { x: 75, y: 150 },
  { x: 0, y: 225 },
  { x: 150, y: 225 },
];

export function getOkidokiLoaderSquareOpacity(elapsedMs: number, index: number): number {
  'worklet';
  const phase =
    (((elapsedMs - index * OKIDOKI_LOADER_STAGGER_MS) % OKIDOKI_LOADER_CYCLE_MS) +
      OKIDOKI_LOADER_CYCLE_MS) %
    OKIDOKI_LOADER_CYCLE_MS;
  if (phase <= OKIDOKI_LOADER_FADE_MS) {
    return (
      OKIDOKI_LOADER_MIN_OPACITY +
      (phase / OKIDOKI_LOADER_FADE_MS) *
        (OKIDOKI_LOADER_MAX_OPACITY - OKIDOKI_LOADER_MIN_OPACITY)
    );
  }
  if (phase <= OKIDOKI_LOADER_FADE_MS * 2) {
    return (
      OKIDOKI_LOADER_MAX_OPACITY -
      ((phase - OKIDOKI_LOADER_FADE_MS) / OKIDOKI_LOADER_FADE_MS) *
        (OKIDOKI_LOADER_MAX_OPACITY - OKIDOKI_LOADER_MIN_OPACITY)
    );
  }
  return OKIDOKI_LOADER_MIN_OPACITY;
}
