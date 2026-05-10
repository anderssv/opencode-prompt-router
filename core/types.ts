export interface Skill {
  name: string;
  description: string;
  path: string;
  tags?: string[];
  raw: string;
}

export interface RouterConfig {
  skillPaths: string[];
  topN: number;
  minScore: number;
  weights: {
    name: number;
    tags: number;
    description: number;
  };
  suppressors: string[];
  idfFloor: number;
  maxMatchingTokens: number;
  minMatchingTokens: number;
  stage2CharLimit: number;
  debug?: boolean;
}

export interface ScoredSkill {
  skill: Skill;
  score: number;
}

export interface RouteResult {
  matches: ScoredSkill[];
  preamble: string;
  tookMs: number;
}
