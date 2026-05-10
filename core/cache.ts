import type { Skill } from "./types";

interface CacheEntry {
  mtime: number;
  skill: Skill;
}

export class SkillCache {
  private readonly store = new Map<string, CacheEntry>();

  get(path: string, mtime: number): Skill | undefined {
    const entry = this.store.get(path);
    if (!entry || entry.mtime !== mtime) return undefined;
    return entry.skill;
  }

  set(path: string, mtime: number, skill: Skill): void {
    this.store.set(path, { mtime, skill });
  }
}
