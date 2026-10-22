import { EventEmitter } from 'node:events';
import type { SeasonInfo } from '@pixel/shared';

/** What the game tells the WebSocket hub. Pixel changes are not events: the hub drains them from the game. */
export interface ServerEventMap {
  season: [SeasonInfo];
  reload: ['season' | 'resize'];
  /** The MeInfo of this wallet changed (balance, tier, faction, ban…). */
  me: [string];
  /** Every authenticated player's MeInfo changed (chaos started, new season). */
  allMe: [];
}

export class ServerEvents extends EventEmitter<ServerEventMap> {}
