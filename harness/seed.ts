/**
 * Seed-population generator.
 *
 *   node harness/seed.ts --builders 30 --seed 42 --out backend/data/seed-population.json
 *
 * For each synthetic builder: 2–5 projects × 1–3 sessions of JSONL written to
 * temp dirs, then fed through the REAL collector pipeline
 * (parseSessionFile → buildEpisodes → extractFeatures → summarize → buildBundle).
 * Output: { generatedAt, seed, builders: [{ handle, persona, bundle }] }.
 */

import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { parseSessionFile } from "../collector/src/parse.ts";
import { buildEpisodes } from "../collector/src/episodes.ts";
import { extractFeatures, type EpisodeFeatures } from "../collector/src/features.ts";
import { summarize, buildBundle, type Bundle, type ProjectSummary } from "../collector/src/report.ts";
import type { ParseStats } from "../collector/src/schema.ts";

import {
  PERSONAS,
  type Persona,
  type Tier,
  mulberry32,
  hashSeed,
  randInt,
} from "./personas.ts";
import { generateSession, DEFAULT_BASE_TS } from "./generate.ts";

export interface SimulatedBuilder {
  handle: string;
  persona: Tier;
  bundle: Bundle;
  feats: EpisodeFeatures[];
}

const TIER_ORDER: Tier[] = ["architect", "builder", "thrasher"];

/**
 * Run one synthetic builder through the real pipeline. Deterministic in
 * (persona, seed): fixed epoch base + seeded PRNG → identical features.
 */
export async function simulateBuilder(
  persona: Persona,
  seed: number,
): Promise<SimulatedBuilder & { handle: string }> {
  const rng = mulberry32(seed);
  const nProjects = randInt(rng, 2, 5);

  const allFeats: EpisodeFeatures[] = [];
  const allStats: ParseStats[] = [];
  const summaries: ProjectSummary[] = [];

  for (let p = 0; p < nProjects; p++) {
    const projectDirName = `sim-${persona.tier}-${seed}-proj${p}`;
    const dir = mkdtempSync(join(tmpdir(), "vs-seed-"));
    const nSessions = randInt(rng, 1, 3);

    const sessions = [];
    for (let s = 0; s < nSessions; s++) {
      // space sessions >4h apart → each session is its own episode
      const baseTs = DEFAULT_BASE_TS + (p * 24 + s * 6) * 3600_000;
      const lines = generateSession(persona, rng, {
        sessionId: `${projectDirName}-s${s}`,
        baseTs,
      });
      const file = join(dir, `session-${s}.jsonl`);
      writeFileSync(file, lines.join("\n"));
      const parsed = await parseSessionFile(file, projectDirName);
      if (parsed) {
        sessions.push(parsed);
        allStats.push(parsed.stats);
      }
    }
    if (sessions.length === 0) continue;

    const episodes = buildEpisodes(sessions);
    const feats = episodes.map((ep) =>
      // shippers: hand the outcome detector an in-window commit timestamp too
      extractFeatures(ep, persona.ending !== "abandon" ? [ep.lastTs] : undefined));
    allFeats.push(...feats);
    summaries.push(summarize(sessions[0].projectHash, feats));
  }

  const bundle = buildBundle(summaries, allFeats, allStats);
  return { handle: "", persona: persona.tier, bundle, feats: allFeats };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nBuilders = Number(argValue(args, "--builders") ?? "30");
  const seed = Number(argValue(args, "--seed") ?? "42");
  const outPath = argValue(args, "--out") ?? "backend/data/seed-population.json";

  const perTierCount: Record<Tier, number> = { architect: 0, builder: 0, thrasher: 0 };
  const builders: Array<{ handle: string; persona: Tier; bundle: Bundle }> = [];

  for (let i = 0; i < nBuilders; i++) {
    const tier = TIER_ORDER[i % TIER_ORDER.length];
    const persona = PERSONAS[tier];
    const n = ++perTierCount[tier];
    const handle = `sim-${tier}-${String(n).padStart(2, "0")}`;
    const builderSeed = hashSeed(seed, tier, i);
    const sim = await simulateBuilder(persona, builderSeed);
    builders.push({ handle, persona: sim.persona, bundle: sim.bundle });
    console.error(`  ${handle}: ${sim.bundle.overall.episodes} episodes, ` +
      `loopBurn ${(sim.bundle.overall.loopBurnFraction * 100).toFixed(1)}%, ` +
      `outcomes ${JSON.stringify(sim.bundle.overall.outcomes)}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    seed,
    builders,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\nseed population written: ${outPath} (${builders.length} builders)`);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// run as CLI only (not when imported by the test)
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("seed.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
