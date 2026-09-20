import { getUser, loadPopulation } from './store.ts';
import { scorePopulation, type Score } from './scoring.ts';

const recommendationByDimension = {
  efficiency: { skill: 'efficiency', id: 'efficiency-context-budget', title: 'Spend context where it helps' },
  direction: { skill: 'framing', id: 'frame-expense-tracker', title: 'Turn an idea into a build brief' },
  craft: { skill: 'verification', id: 'verify-pagination', title: 'Test what the demo missed' },
  shipping: { skill: 'review', id: 'review-ai-patch', title: 'Review a patch that weakens a test' },
} as const;

export interface WorkflowView extends Omit<Score, 'synthetic'> {
  episodes: number;
  agent: string;
  generatedAt: string;
  recommendation: { skill: string; id: string; title: string; path: string };
}

/** Recompute every current workflow score against the same full comparison population. */
export function currentWorkflowScores(): WorkflowView[] {
  const population = loadPopulation();
  const bundles = new Map(population.map(entry => [entry.handle, entry.bundle]));
  return scorePopulation(population).map(({ synthetic: _synthetic, ...score }) => {
    const bundle = bundles.get(score.handle)!;
    const weakest = (Object.entries(score.subscores) as Array<[keyof typeof recommendationByDimension, number]>)
      .sort(([leftKey, left], [rightKey, right]) => left - right || leftKey.localeCompare(rightKey))[0][0];
    const drill = recommendationByDimension[weakest];
    return {
      ...score,
      episodes: bundle.overall.episodes,
      agent: bundle.agent,
      generatedAt: bundle.generatedAt,
      recommendation: { ...drill, path: `/challenge/${drill.id}` },
    };
  });
}

export function currentWorkflowScore(handle: string): WorkflowView | null {
  return currentWorkflowScores().find(score => score.handle === handle) ?? null;
}

/** Public projections always enforce current account visibility. */
export function publicWorkflowScore(handle: string): WorkflowView | null {
  return getUser(handle)?.isPublic ? currentWorkflowScore(handle) : null;
}

export function publicWorkflowLeaderboard(limit = 100): WorkflowView[] {
  const bounded = Math.max(1, Math.min(250, Number.isFinite(limit) ? Math.floor(limit) : 100));
  return currentWorkflowScores()
    .filter(score => getUser(score.handle)?.isPublic)
    .sort((a, b) => b.rating - a.rating || a.rd - b.rd || b.episodes - a.episodes || a.handle.localeCompare(b.handle))
    .slice(0, bounded);
}
