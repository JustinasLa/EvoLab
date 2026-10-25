import {
  creature,
  mutate,
  Random,
  type Generation,
  type Genome,
  type Settings,
  type Trial,
} from './model';
import { evaluate } from './physics';

export class Evolution {
  readonly random: Random;
  population: Genome[];
  index = 0;
  constructor(
    readonly settings: Settings,
    founder?: Genome,
  ) {
    this.random = new Random(settings.seed);
    this.population = Array.from({ length: settings.population }, (_, i) =>
      founder
        ? i === 0
          ? structuredClone(founder)
          : mutate(founder, this.random, settings.mutation)
        : creature(this.random),
    );
  }
  assess(index: number): Trial {
    return evaluate(this.population[index], this.settings, false);
  }
  advance(trials: Trial[]): Generation {
    if (trials.length !== this.settings.population)
      throw new Error('A generation must evaluate every creature.');
    const ranked = [...trials].sort((a, b) => b.fitness - a.fitness);
    const champion = evaluate(ranked[0].genome, this.settings);
    const elites = ranked.slice(0, 2).map((t) => t.genome);
    const survivors = ranked.slice(0, Math.max(3, Math.floor(ranked.length / 4)));
    this.population = [
      ...elites,
      ...Array.from({ length: this.settings.population - 2 }, (_, i) =>
        i === this.settings.population - 3
          ? creature(this.random)
          : mutate(
              survivors[this.random.int(0, survivors.length)].genome,
              this.random,
              this.settings.mutation,
            ),
      ),
    ];
    return {
      index: ++this.index,
      best: champion.fitness,
      median: ranked[Math.floor(ranked.length / 2)].fitness,
      diversity: new Set(ranked.map((t) => t.genome.genes.length)).size,
      champion,
    };
  }
}
