/** Regulation-style dimensions in meters (US cornhole). */
export const CORNHOLE = {
  board: {
    widthM: 0.6096, // 2 ft
    lengthM: 1.2192, // 4 ft
    thicknessM: 0.03,
    /** Hole center is 9 in from the top (back) edge along the center line. */
    holeRadiusM: 0.1524 / 2, // 6 in diameter
    /** Local +Z is toward the back edge; board spans [-length/2, +length/2]. */
    holeCenterZLocal: 0.6096 - 0.2286, // 9 in from back
  },
  /** Regulation cornhole bag: 6" × 6" × ~2", 1 lb (Cannon uses SI: kg, m, N·s). */
  bag: {
    widthM: 6 * 0.0254,
    depthM: 6 * 0.0254,
    thicknessM: 2 * 0.0254,
    massKg: 0.45359237, // 1 lb
  },
  /** Thin physics slab on the deck top (m); invisible colliders only. */
  deckColliderThicknessM: 0.018,
  ground: {
    sizeM: 40,
  },
  /** Board center world position. */
  boardWorld: {
    x: 0,
    y: 0.515,
    z: 3,
  },
  /** Spawn / throw: bag center height ~hand release; -Z toward camera. */
  throwLine: {
    x: 0,
    z: 0.5,
  },
} as const;

/** Center Y of bag at throw (meters above origin). */
export function throwLineY(): number {
  return CORNHOLE.bag.thicknessM / 2 + 0.38;
}
