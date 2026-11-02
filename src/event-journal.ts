import { Ecosystem } from './ecosystem';
import { CELL_NAMES, WORLD_MAX_BYTES, WORLD_VERSION } from './model';
import {
  EVENT_CAPACITY,
  EVENT_RULES,
  REPLAY_BYTES,
  REPLAY_CAPACITY,
  REPLAY_RULES,
  REPLAY_WINDOW,
  type EventJournal,
  type EventReplay,
  type ObservedEvent,
} from './event-model';

export function completeCheckpoint(world: Ecosystem): string {
  const text = JSON.stringify(world.save());
  if (new TextEncoder().encode(text).byteLength > WORLD_MAX_BYTES)
    throw new Error('Complete event checkpoint exceeds 2.5 MB; exact replay unavailable.');
  return text;
}

export class EventRecorder {
  private journal: EventJournal;
  private population: number;
  private lineages = new Set<number>();
  private traits = new Set<string>();
  private sequence = 0;
  private boundary = 0;
  private source: { tick: number; text: string } | undefined;
  private evidence: { ids: number[]; replay: EventReplay; bytes: number }[] = [];

  constructor(world: Ecosystem) {
    this.journal = {
      originTick: world.tick,
      tick: world.tick,
      evicted: 0,
      evidenceEvicted: 0,
      problem: '',
      events: [],
    };
    this.population = world.organisms.size;
    this.observe(world, true);
  }

  observe(world: Ecosystem, barrier = false): void {
    this.journal.tick = world.tick;
    const arrivals: ObservedEvent[] = [];
    const add = (kind: ObservedEvent['kind'], detail: string): void => {
      arrivals.push({ id: ++this.sequence, tick: world.tick, kind, detail, replay: false });
    };
    const living = new Set<number>();
    for (const organism of world.organisms.values()) {
      living.add(organism.species);
      const observed = [
        ...organism.genome.cells.map((cell) => CELL_NAMES[cell.type - 3]),
        `behavior: ${organism.genome.behavior.mode}`,
      ];
      for (const trait of observed)
        if (!this.traits.has(trait)) {
          this.traits.add(trait);
          add(
            'first-trait',
            `First observed ${trait} since recording began; not its historical origin.`,
          );
        }
    }
    for (const lineage of this.lineages)
      if (!living.has(lineage))
        add(
          'lineage-extinction',
          `Lineage ${lineage}: previously living, now zero observed members.`,
        );
    if (
      this.population - world.organisms.size >= 5 &&
      world.organisms.size <= this.population * 0.75
    )
      add(
        'population-drop',
        `Population ${this.population} → ${world.organisms.size}: at least 5 and 25% lost between consecutive observations.`,
      );
    this.population = world.organisms.size;
    this.lineages = living;
    this.journal.events.push(...arrivals);
    while (this.journal.events.length > EVENT_CAPACITY) {
      this.journal.events.shift();
      this.journal.evicted++;
    }
    try {
      if (barrier || !this.source || world.tick - this.source.tick > REPLAY_WINDOW) {
        this.boundary++;
        this.source = undefined;
        this.source = { tick: world.tick, text: completeCheckpoint(world) };
      }
      if (arrivals.length) {
        const endpoint = completeCheckpoint(world);
        this.evidence.push({
          ids: arrivals.slice(-EVENT_CAPACITY).map((event) => event.id),
          bytes: new TextEncoder().encode(this.source.text + endpoint).byteLength,
          replay: {
            rules: REPLAY_RULES,
            eventRules: EVENT_RULES,
            worldVersion: WORLD_VERSION,
            boundary: this.boundary,
            interventions: [],
            sourceTick: this.source.tick,
            endpointTick: world.tick,
            checkpoint: this.source.text,
            endpoint,
          },
        });
      }
      this.journal.problem = '';
    } catch (error) {
      this.source = undefined;
      this.journal.problem = (error as Error).message;
    }
    while (
      this.evidence.length > REPLAY_CAPACITY ||
      this.evidence.reduce((sum, item) => sum + item.bytes, 0) > REPLAY_BYTES
    ) {
      this.evidence.shift();
      this.journal.evidenceEvicted++;
    }
    for (const event of this.journal.events)
      event.replay = this.evidence.some((item) => item.ids.includes(event.id));
  }

  snapshot(): EventJournal {
    return structuredClone(this.journal);
  }

  replay(id: number): EventReplay {
    const evidence = this.evidence.find((item) => item.ids.includes(id));
    if (!evidence || !this.journal.events.some((event) => event.id === id))
      throw new Error(
        'Event or complete replay evidence was evicted; no reconstruction available.',
      );
    return structuredClone(evidence.replay);
  }
}
