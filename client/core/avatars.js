/* Player identity shared by every game: a name (typed by the player) plus one of these colour avatars.
   The index is what travels over the wire; games map it to whatever they like (the kart game maps it to a kart skin). */
export const AVATARS = [
  { name: 'Frost', color: 0xff3b3b }, { name: 'Yeti', color: 0x3b82f6 }, { name: 'Blizzard', color: 0xfacc15 }, { name: 'Glacier', color: 0x22c55e },
  { name: 'Aurora', color: 0xa855f7 }, { name: 'Flurry', color: 0xf97316 }, { name: 'Penguin', color: 0x06b6d4 }, { name: 'Frostbite', color: 0xf472b6 },
];
export const MAX_NAME = 12;
export const cleanName = n => (String(n || '').trim().slice(0, MAX_NAME)) || 'Player';
export const cleanAvatar = a => Number.isInteger(a) && a >= 0 && a < AVATARS.length ? a : -1;
