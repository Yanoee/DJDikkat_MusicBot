/************************************************************
 * DJ DIKKAT - Music Bot
 * Shared types
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import type { Shoukaku, Track } from 'shoukaku';

// index.ts attaches the Shoukaku instance to the discord.js client.
declare module 'discord.js' {
  interface Client {
    shoukaku: Shoukaku;
  }
}

/** A NodeLink track plus who asked for it. */
export interface QueueTrack extends Track {
  requesterId: string;
  requesterTag: string;
}

export interface LastPlayed {
  title: string;
  uri: string | null;
}
