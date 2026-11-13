import type { PublicModel } from './types';

export function validGenerationDimensions(
  dimensions: PublicModel['capabilities']['dimensions'], width: number, height: number,
): boolean {
  return [width, height].every(value => Number.isInteger(value)
    && value >= dimensions.min && value <= dimensions.max && value % dimensions.step === 0);
}
