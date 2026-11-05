const test = require("node:test");
const assert = require("node:assert/strict");
const Key = require("./key.js");

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function spectrum(notes, sampleRate, fftSize) {
  const mags = new Float64Array(fftSize / 2);
  for (const note of notes) {
    const f0 = midiToFreq(note.midi);
    const harmonics = note.harmonics || 6;
    for (let h = 1; h <= harmonics; h++) {
      const freq = f0 * h;
      if (freq >= sampleRate / 2) break;
      const bin = Math.round((freq * fftSize) / sampleRate);
      if (bin > 0 && bin < mags.length) mags[bin] += note.amp / h;
    }
  }
  return mags;
}

function detect(notes) {
  const sampleRate = 44100;
  const mags = spectrum(notes, sampleRate, 8192);
  return Key.estimateKey(Key.chromaFromMagnitudes(mags, sampleRate));
}

test("names every major and minor scale with seven distinct pitches", () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"]) {
      const notes = Key.spellScale(tonic, mode);
      assert.equal(notes.length, 7, Key.keyName(tonic, mode));
      const pcs = new Set(notes.map((note) => note.pc));
      assert.equal(pcs.size, 7, Key.keyName(tonic, mode) + " " + notes.map((n) => n.label).join(" "));
      for (const note of notes) {
        assert.match(note.label, /^[A-G](♯|♭|𝄪|𝄫)?$/u);
      }
    }
  }
});

test("spells familiar scales", () => {
  const labels = (tonic, mode) => Key.spellScale(tonic, mode).map((note) => note.label).join(" ");
  assert.equal(labels(9, "major"), "A B C♯ D E F♯ G♯");
  assert.equal(labels(0, "major"), "C D E F G A B");
  assert.equal(labels(5, "major"), "F G A B♭ C D E");
  assert.equal(labels(10, "major"), "B♭ C D E♭ F G A");
  assert.equal(labels(6, "major"), "F♯ G♯ A♯ B C♯ D♯ E♯");
  assert.equal(labels(9, "minor"), "A B C D E F G");
  assert.equal(labels(0, "minor"), "C D E♭ F G A♭ B♭");
  assert.equal(labels(6, "minor"), "F♯ G♯ A B C♯ D E");
});

test("matches a profile-shaped chroma to that key", () => {
  const profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const chroma = new Float64Array(12);
  for (let i = 0; i < 12; i++) chroma[(9 + i) % 12] = profile[i];
  const found = Key.estimateKey(chroma);
  assert.equal(found.name, "A major");
  assert.ok(found.score > 0.99, String(found.score));
});

test("finds the key of weighted chords", () => {
  const cases = [
    { name: "A major", notes: [57, 61, 64, 69, 73, 76] },
    { name: "C major", notes: [48, 52, 55, 60, 64, 67] },
    { name: "F major", notes: [53, 57, 60, 65, 69, 72] },
    { name: "B♭ major", notes: [46, 50, 53, 58, 62, 65] },
    { name: "E major", notes: [52, 56, 59, 64, 68, 71] },
    { name: "A minor", notes: [57, 60, 64, 69, 72, 76] },
    { name: "C minor", notes: [48, 51, 55, 60, 63, 67] },
    { name: "D minor", notes: [50, 53, 57, 62, 65, 69] },
    { name: "F♯ minor", notes: [54, 57, 61, 66, 69, 73] },
  ];
  for (const item of cases) {
    const found = detect(item.notes.map((midi, index) => ({ midi, amp: index < 3 ? 1.4 : 1 })));
    assert.equal(found.name, item.name, JSON.stringify({ got: found.name, score: found.score, runner: found.runnerUp.name }));
  }
});

test("silence does not invent a correlation", () => {
  const found = Key.estimateKey(new Float64Array(12));
  assert.equal(found.score, 0);
});
