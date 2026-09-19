/**
 * Episode segmentation — fix for design fault #1 (sessions ≠ tasks).
 *
 * A work episode is a burst of sessions on one project separated by no
 * more than GAP_MS of inactivity. All skill features are computed per
 * episode; sidechain (subagent) events stay attached to their episode
 * and are costed as delegated work (design fault #2).
 */

import type { Event, ParsedSession } from "./schema.ts";

export const GAP_MS = 4 * 60 * 60 * 1000; // 4h
export const IDLE_CAP_MS = 10 * 60 * 1000; // gaps beyond this don't count as active time

export interface Episode {
  projectHash: string;
  sessionIds: string[];
  events: Event[]; // time-ordered, sidechains included
  firstTs: number;
  lastTs: number;
  /** wall-clock with idle gaps (>10 min) excised, ms */
  activeMs: number;
}

export function buildEpisodes(sessions: ParsedSession[]): Episode[] {
  const byProject = new Map<string, ParsedSession[]>();
  for (const s of sessions) {
    const list = byProject.get(s.projectHash) ?? [];
    list.push(s);
    byProject.set(s.projectHash, list);
  }

  const episodes: Episode[] = [];
  for (const [projectHash, list] of byProject) {
    list.sort((a, b) => a.firstTs - b.firstTs);
    let current: ParsedSession[] = [];
    let lastEnd = -Infinity;
    const flush = () => {
      if (current.length > 0) episodes.push(toEpisode(projectHash, current));
      current = [];
    };
    for (const s of list) {
      if (s.firstTs - lastEnd > GAP_MS) flush();
      current.push(s);
      lastEnd = Math.max(lastEnd, s.lastTs);
    }
    flush();
  }
  episodes.sort((a, b) => a.firstTs - b.firstTs);
  return episodes;
}

function toEpisode(projectHash: string, sessions: ParsedSession[]): Episode {
  const events = sessions
    .flatMap((s) => s.events)
    .filter((e) => e.ts > 0)
    .sort((a, b) => a.ts - b.ts);
  let activeMs = 0;
  for (let i = 1; i < events.length; i++) {
    activeMs += Math.min(events[i].ts - events[i - 1].ts, IDLE_CAP_MS);
  }
  return {
    projectHash,
    sessionIds: sessions.map((s) => s.sessionId),
    events,
    firstTs: events[0]?.ts ?? sessions[0].firstTs,
    lastTs: events[events.length - 1]?.ts ?? sessions[sessions.length - 1].lastTs,
    activeMs,
  };
}
