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
  /** Regulation cornhole bag: 6" × 6", ~0.75" thick when filled, 1 lb (SI: kg, m). */
  bag: {
    widthM: 6 * 0.0254,
    depthM: 6 * 0.0254,
    thicknessM: 0.75 * 0.0254,
    massKg: 0.45359237, // 1 lb
  },
  /** Thick physics slab for reliable soft-body collision (m); invisible. */
  deckColliderThicknessM: 0.25,
  ground: {
    sizeM: 40,
  },
  /**
   * Board center world position.  The board is tilted so the front edge
   * rests on the ground and the back-edge top is ~10 in (0.2517 m).
   */
  boardWorld: {
    x: 0,
    y: 0.1259,
    z: 8.2296, // 27 ft from throw line
  },
  /** Tilt angle in radians (~10.5°).  Front edge on ground, back top at ~10 in. */
  boardTiltRad: 0.1833,
  /** Spawn / throw: bag center height ~hand release; -Z toward camera. */
  throwLine: {
    x: 0,
    z: 0,
  },
} as const;

/** Center Y of bag at throw (meters above origin). */
export function throwLineY(): number {
  return 0.9144; // 3 ft
}
