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
  bag: {
    sizeM: 0.12,
    mass: 0.45,
  },
  ground: {
    sizeM: 40,
  },
  /** Board center world position. */
  boardWorld: {
    x: 0,
    y: 0.515,
    z: 3,
  },
  /** Spawn / throw line in front of the board (-Z is toward the camera). */
  throwLine: {
    x: 0,
    y: 0.55,
    z: 0.5,
  },
} as const;
