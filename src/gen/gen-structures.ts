/**
 * Structure generators — barrel file re-exporting from individual modules.
 * Each generator lives in its own gen-*.ts file for maintainability.
 */

export { generateTower } from './gen-tower.js';
export { generateCastle } from './gen-castle.js';
export { generateDungeon } from './gen-dungeon.js';
export { generateShip } from './gen-ship.js';
export { generateCathedral } from './gen-cathedral.js';
export { generateBridge } from './gen-bridge.js';
export { generateWindmill } from './gen-windmill.js';
export { generateMarketplace } from './gen-marketplace.js';
export { generateVillage } from './gen-village.js';
