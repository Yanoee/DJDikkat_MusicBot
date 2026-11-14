/************************************************************
 * DJ DIKKAT - Music Bot
 * Shared types
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
  autoplay?: boolean;   // picked by autoplay, not by a person
  autoplayFrom?: string; // autoplay only: title of the song it was picked for ("like X"), ≤100 chars
}

export interface LastPlayed {
  title: string;
  uri: string | null;
}
