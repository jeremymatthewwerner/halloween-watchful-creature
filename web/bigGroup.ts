/**
 * Big-group mode: a big group (or a line forming) gets one quick group welcome, a shout-out to one or two
 * standout costumes and one fun group moment, instead of costume-by-costume compliments while kids wait
 * for candy. No mini-game. Kept DOM-free so it can be tested.
 */

/** This many visitors at once is a big group. */
export const BIG_GROUP_SIZE = 4;

/** A group that has grown this many times in one visit is a line forming, however many are in view. */
export const LINE_GROWS = 2;

/**
 * How many people we think are there: the tracker's count, raised by the vision description's count when
 * it states one. The detector can miss kids bunched together or in masks, but never sees people who aren't
 * there, so vision can only raise the count, never lower it.
 */
export function groupSize(trackerCount: number, seen?: string | null): number {
  return Math.max(trackerCount, (seen && visionCount(seen)) || 0);
}

export function isBigGroup(size: number, grows = 0): boolean {
  return size >= BIG_GROUP_SIZE || grows >= LINE_GROWS;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * The number of people a vision description states ("Five visitors close to the decoration", "3 kids"), or
 * null if it states none. Takes the largest, so "Four visitors: two in front..." counts four.
 */
export function visionCount(seen: string): number | null {
  const words = Object.keys(NUMBER_WORDS).join("|");
  const pattern = new RegExp(`\\b(\\d{1,2}|${words})\\s+(?:[a-z-]+\\s+)?(?:visitors|people|kids|children|trick-or-treaters)\\b`, "gi");
  let most: number | null = null;
  for (const match of seen.matchAll(pattern)) {
    const word = match[1]!.toLowerCase();
    const n = NUMBER_WORDS[word] ?? Number(word);
    if (n > 0 && n > (most ?? 0)) most = n;
  }
  return most;
}

/** What a big group's greeting asks for. `newcomers`: the group grew, so it's the new arrivals' welcome. */
export function bigGroupPlan(newcomers = false): string {
  const welcome = newcomers
    ? "give the newcomers one quick group welcome, shout out one or two of their standout costumes"
    : "give the whole group one quick welcome, shout out one or two standout costumes";
  return (
    "It's a big group and kids are waiting for candy, so keep it quick and don't go costume by costume: " +
    `${welcome}, then one fun group moment, like a quick joke or everybody shouting "trick or treat!" together. ` +
    "Don't start a mini-game with this group."
  );
}

/** The conversation-log note for a big-group greeting. */
export function bigGroupNote(size: number, grows = 0): string {
  return size < BIG_GROUP_SIZE && grows >= LINE_GROWS ? `big group (${size}): a line is forming` : `big group (${size})`;
}
