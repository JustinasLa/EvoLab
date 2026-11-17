import { clamp, exactDataRecord, integer, type Genome, type Random } from './model';

export interface Senses {
  version: 1;
  orientation: number;
  range: number;
  fov: 1 | 3 | 4;
  temperature: boolean;
}
export const SENSE_CHANNELS = [
  'eye-orientation',
  'eye-range',
  'eye-fov',
  'temperature-sensor',
] as const;
export const EYE_CELL_COST = 0.001;
export const TEMPERATURE_SAMPLE_COST = 0.008;
export const SENSE_INPUTS = 10;
export const SENSE_WEIGHTS = 56;
export const newSenses = (): Senses => ({
  version: 1,
  orientation: 0,
  range: 5,
  fov: 1,
  temperature: false,
});

export function validSenses(value: unknown): value is Senses {
  return (
    exactDataRecord(value, ['version', 'orientation', 'range', 'fov', 'temperature']) &&
    value.version === 1 &&
    integer(value.orientation, 0, 3) &&
    integer(value.range, 1, 8) &&
    [1, 3, 4].includes(value.fov as number) &&
    typeof value.temperature === 'boolean'
  );
}

export function sameSenses(first?: Senses, second?: Senses): boolean {
  if (!first || !second) return first === second;
  return (
    first.orientation === second.orientation &&
    first.range === second.range &&
    first.fov === second.fov &&
    first.temperature === second.temperature
  );
}

export function mutateSenses(
  genome: Genome,
  random: Random,
  observe?: (channel: string) => void,
): Genome {
  if (!genome.senses) return genome;
  const senses = { ...genome.senses },
    channel = random.int(4),
    choice = random.next();
  observe?.(SENSE_CHANNELS[channel]);
  if (channel === 0) senses.orientation = (senses.orientation + 1 + Math.floor(choice * 3)) % 4;
  else if (channel === 1) senses.range = clamp(senses.range + (choice < 0.5 ? -1 : 1), 1, 8);
  else if (channel === 2) {
    const alternatives = ([1, 3, 4] as const).filter((fov) => fov !== senses.fov);
    senses.fov = alternatives[Math.floor(choice * 2)];
  } else senses.temperature = !senses.temperature;
  return { ...genome, senses };
}
