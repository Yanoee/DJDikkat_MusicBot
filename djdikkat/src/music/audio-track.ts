/************************************************************
 * DJ DIKKAT - Music Bot
 * Original audio
 * YouTube marks its AI auto-dub as the default audio track,
 * so NodeLink would play the dub. This picks the original
 * track from pluginInfo.audioTracks for the play payload.
 * Author: Yanoee
 ************************************************************/

interface AudioTrack { id: string; name: string; isDefault: boolean; isAutoDubbed: boolean }

function toAudioTracks(raw: unknown): AudioTrack[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((t: unknown) => {
    if (!t || typeof t !== 'object') return [];
    const { id, name, isDefault, isAutoDubbed } = t as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return [];
    return [{ id, name: typeof name === 'string' ? name : '', isDefault: isDefault === true, isAutoDubbed: isAutoDubbed === true }];
  });
}

/**
 * The audio track ID to request instead of an auto-dubbed default, or
 * undefined to keep NodeLink's default (no dub, no data, bad data).
 * Prefers a track named "original", else the first non-dubbed one.
 */
export function originalAudioTrackId(pluginInfo: unknown): string | undefined {
  if (!pluginInfo || typeof pluginInfo !== 'object') return undefined;
  const tracks = toAudioTracks((pluginInfo as Record<string, unknown>).audioTracks);
  if (!tracks.find(t => t.isDefault)?.isAutoDubbed) return undefined;
  const real = tracks.filter(t => !t.isAutoDubbed);
  return (real.find(t => /original/i.test(t.name)) ?? real[0])?.id;
}
