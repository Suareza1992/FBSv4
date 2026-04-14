export const TileType = {
  GRASS:      0,
  ROAD:       1,
  SIDEWALK:   2,
  BUILDING:   3,
  DOOR:       4,
  WATER:      5,
};

// Which tile types block movement
export const SOLID_TILES = new Set([
  TileType.BUILDING,
]);

// Which tile types are door triggers (handled separately by Door entities)
export const DOOR_TILES = new Set([
  TileType.DOOR,
]);
