// Pitch-class key finding.
// Microphone audio is folded into 12 pitch classes, then matched with the
// Krumhansl–Schmuckler major and minor profiles.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.KeyFinder = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Weights for C. Index 0 is the tonic, then each semitone up to the leading tone.
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
  const NATURAL_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

  function prefersFlats(tonic, mode) {
    if (mode === "major") return [1, 3, 5, 8, 10].includes(tonic);
    return [0, 2, 3, 5, 7, 10].includes(tonic);
  }

  function keyName(tonic, mode) {
    const names = prefersFlats(tonic, mode) ? FLAT_NAMES : SHARP_NAMES;
    return names[tonic] + " " + mode;
  }

  // Camelot wheel: major = B, minor = A; a minor key shares its number with its relative major.
  function camelot(tonic, mode) {
    const majorTonic = mode === "major" ? tonic : (tonic + 3) % 12;
    return ((majorTonic * 7 + 7) % 12) + 1 + (mode === "major" ? "B" : "A");
  }

  function spellScale(tonic, mode) {
    const names = prefersFlats(tonic, mode) ? FLAT_NAMES : SHARP_NAMES;
    const steps = mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
    let letterIndex = LETTERS.indexOf(names[tonic][0]);
    return steps.map(function (interval) {
      const pc = (tonic + interval) % 12;
      const letter = LETTERS[letterIndex];
      letterIndex = (letterIndex + 1) % 7;
      let delta = (pc - NATURAL_PC[letter] + 12) % 12;
      if (delta > 6) delta -= 12;
      let accidental = "";
      if (delta === 1) accidental = "♯";
      else if (delta === 2) accidental = "𝄪";
      else if (delta === -1) accidental = "♭";
      else if (delta === -2) accidental = "𝄫";
      return { pc: pc, label: letter + accidental };
    });
  }

  function scoreKey(chroma, tonic, mode) {
    const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
    let sumC = 0;
    let sumP = 0;
    for (let i = 0; i < 12; i++) {
      sumC += chroma[i];
      sumP += profile[i];
    }
    const meanC = sumC / 12;
    const meanP = sumP / 12;
    let num = 0;
    let denC = 0;
    let denP = 0;
    for (let i = 0; i < 12; i++) {
      const pc = (tonic + i) % 12;
      const dc = chroma[pc] - meanC;
      const dp = profile[i] - meanP;
      num += dc * dp;
      denC += dc * dc;
      denP += dp * dp;
    }
    const den = Math.sqrt(denC * denP);
    return den === 0 ? 0 : num / den;
  }

  function estimateKey(chroma) {
    let best = null;
    let runnerUp = null;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (let m = 0; m < 2; m++) {
        const mode = m === 0 ? "major" : "minor";
        const score = scoreKey(chroma, tonic, mode);
        const candidate = { tonic: tonic, mode: mode, score: score, name: keyName(tonic, mode) };
        if (!best || score > best.score) {
          runnerUp = best;
          best = candidate;
        } else if (!runnerUp || score > runnerUp.score) {
          runnerUp = candidate;
        }
      }
    }
    best.margin = best.score - (runnerUp ? runnerUp.score : 0);
    best.notes = spellScale(best.tonic, best.mode);
    best.runnerUp = runnerUp;
    return best;
  }

  // magnitudes: linear amplitude per FFT bin (length = fftSize / 2).
  function chromaFromMagnitudes(magnitudes, sampleRate) {
    const chroma = new Float64Array(12);
    const fftSize = magnitudes.length * 2;
    for (let i = 1; i < magnitudes.length; i++) {
      const amp = magnitudes[i];
      if (!(amp > 0)) continue;
      const freq = (i * sampleRate) / fftSize;
      if (freq < 70 || freq > 4200) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const nearest = Math.round(midi);
      const dist = Math.abs(midi - nearest);
      if (dist > 0.4) continue;
      const pc = ((nearest % 12) + 12) % 12;
      const align = Math.cos((dist * Math.PI) / 2);
      const rolloff = freq < 1800 ? 1 : Math.exp(-(freq - 1800) / 1400);
      chroma[pc] += Math.log1p(amp * amp) * align * rolloff;
    }
    return chroma;
  }

  function chromaFromDecibels(decibels, sampleRate) {
    const magnitudes = new Float64Array(decibels.length);
    for (let i = 0; i < decibels.length; i++) {
      const db = decibels[i];
      magnitudes[i] = Number.isFinite(db) && db > -100 ? Math.pow(10, db / 20) : 0;
    }
    return chromaFromMagnitudes(magnitudes, sampleRate);
  }

  return {
    estimateKey: estimateKey,
    spellScale: spellScale,
    keyName: keyName,
    camelot: camelot,
    chromaFromMagnitudes: chromaFromMagnitudes,
    chromaFromDecibels: chromaFromDecibels,
  };
});
