/** Key estimation: mean of the fine chroma correlated with Krumhansl–Kessler profiles. */

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export interface KeyEstimate {
  camelot: string;
  name: string;
  confidence: number;
}

function correlation(values: number[], profile: number[], tonic: number): number {
  const meanValue = values.reduce((total, value) => total + value, 0) / 12;
  const meanProfile = profile.reduce((total, value) => total + value, 0) / 12;
  let numerator = 0;
  let left = 0;
  let right = 0;
  for (let pitch = 0; pitch < 12; pitch += 1) {
    const a = (values[(pitch + tonic) % 12] ?? 0) - meanValue;
    const b = (profile[pitch] ?? 0) - meanProfile;
    numerator += a * b;
    left += a * a;
    right += b * b;
  }
  return numerator / Math.sqrt(Math.max(1e-12, left * right));
}

export function estimateKeyFromChroma(chroma: number[]): KeyEstimate {
  const candidates: { camelot: string; name: string; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    candidates.push({
      camelot: MAJOR_CAMELOT[tonic] ?? "",
      name: `${NOTE_NAMES[tonic]} major`,
      score: correlation(chroma, MAJOR_PROFILE, tonic),
    });
    candidates.push({
      camelot: MINOR_CAMELOT[tonic] ?? "",
      name: `${NOTE_NAMES[tonic]} minor`,
      score: correlation(chroma, MINOR_PROFILE, tonic),
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const second = candidates[1];
  if (!best) return { camelot: "", name: "unknown", confidence: 0 };
  const margin = best.score - (second?.score ?? 0);
  return { camelot: best.camelot, name: best.name, confidence: Math.max(0, Math.min(1, 0.4 + margin * 3)) };
}

/** Averages unit-sum chroma frames over the middle 80 % of the track. */
export function estimateKey(fineChroma: Float32Array): KeyEstimate {
  const frames = Math.floor(fineChroma.length / 12);
  const start = Math.floor(frames * 0.1);
  const end = Math.max(start + 1, Math.floor(frames * 0.9));
  const chroma = new Array<number>(12).fill(0);
  let count = 0;
  for (let frame = start; frame < end; frame += 1) {
    for (let pc = 0; pc < 12; pc += 1) chroma[pc] = (chroma[pc] ?? 0) + (fineChroma[frame * 12 + pc] ?? 0);
    count += 1;
  }
  if (count === 0) return { camelot: "", name: "unknown", confidence: 0 };
  return estimateKeyFromChroma(chroma.map((value) => value / count));
}
