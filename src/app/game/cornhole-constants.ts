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

/** World +Z of the board’s back edge (far from the throw line). */
export function boardBackEdgeWorldZ(): number {
  return CORNHOLE.boardWorld.z + CORNHOLE.board.lengthM * 0.5;
}

/** Throws are tuned so landing distance does not exceed this past the back edge (~4 ft). */
export const MAX_PAST_BOARD_M = 4 * 0.3048;

/**
 * Max horizontal speed magnitude (m/s) after pull + loft + release-speed scaling.
 * Works with `MAX_PAST_BOARD_M` so hard throws stay near the regulation “past board” limit.
 */
export const MAX_THROW_HORIZ_SPEED_MPS = 25.5;

/** Ground distance (m) that must be dragged for full pull power — larger = less sensitive. */
export const PULL_DISTANCE_FOR_FULL_POWER_M = 5.0;

/** Boost to horizontal + upward velocity at mouse release. */
export const THROW_RELEASE_ENERGY_MUL = 1.12;
