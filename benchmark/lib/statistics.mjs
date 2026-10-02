export function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const fraction = position - lower
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
}

export function mean(values) {
  const finite = values.filter(Number.isFinite)
  return finite.length === 0 ? undefined : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

export function geometricMean(values) {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0)
  return positive.length === 0 ? undefined : Math.exp(mean(positive.map(Math.log)))
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite)
  return {
    n: finite.length,
    mean: mean(finite),
    p50: quantile(finite, 0.5),
    p90: quantile(finite, 0.9),
  }
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6d2b79f5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function bootstrapGeometricMeanCI(values, { samples = 4_000, seed = 20260817 } = {}) {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0)
  if (positive.length < 2) return undefined
  const random = mulberry32(seed)
  const estimates = []
  for (let sample = 0; sample < samples; sample += 1) {
    const draw = Array.from({ length: positive.length }, () => positive[Math.floor(random() * positive.length)])
    estimates.push(geometricMean(draw))
  }
  return { low: quantile(estimates, 0.025), high: quantile(estimates, 0.975) }
}
