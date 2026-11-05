(function () {
  const FIRST_MIDI = 48; // C3
  const LAST_MIDI = 72; // C5
  const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
  const SILENCE_RMS = 0.004;
  const SMOOTHING = 0.035;
  const MIN_SCORE = 0.55;
  const HOLD_MS = 1200;

  const listenButton = document.getElementById("listen");
  const statusEl = document.getElementById("status");
  const levelEl = document.getElementById("level");
  const keyNameEl = document.getElementById("key-name");
  const notesEl = document.getElementById("scale-notes");
  const confidenceEl = document.getElementById("confidence");
  const pianoEl = document.getElementById("piano");

  const keyEls = [];
  let audio = null;
  let chroma = new Float64Array(12);
  let shown = null;
  let pending = null;
  let pendingSince = 0;
  let heardMs = 0;
  let starting = false;

  function midiToPc(midi) {
    return ((midi % 12) + 12) % 12;
  }

  function naturalLabel(midi) {
    const pc = midiToPc(midi);
    const letter = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"][pc];
    const octave = Math.floor(midi / 12) - 1;
    return letter === "C" ? letter + octave : letter;
  }

  function buildPiano() {
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const pc = midiToPc(midi);
      if (!WHITE_PCS.has(pc)) continue;
      const white = document.createElement("div");
      white.className = "white-key";
      white.dataset.pc = String(pc);
      white.dataset.natural = naturalLabel(midi);
      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = white.dataset.natural;
      white.appendChild(label);
      pianoEl.appendChild(white);
      keyEls.push(white);

      const nextPc = (pc + 1) % 12;
      if (WHITE_PCS.has(nextPc) || midi === LAST_MIDI) continue;
      const black = document.createElement("div");
      black.className = "black-key";
      black.dataset.pc = String(nextPc);
      const blackLabel = document.createElement("span");
      blackLabel.className = "key-label";
      black.appendChild(blackLabel);
      white.appendChild(black);
      keyEls.push(black);
    }
  }

  function renderKeyName(name) {
    keyNameEl.replaceChildren();
    const match = /^([A-G])([♯♭𝄪𝄫]?) (major|minor)$/u.exec(name || "");
    if (!match) {
      keyNameEl.textContent = name || "—";
      return;
    }
    keyNameEl.append(match[1]);
    if (match[2]) {
      const accidental = document.createElement("span");
      accidental.className = "accidental";
      accidental.textContent = match[2];
      keyNameEl.append(accidental);
    }
    keyNameEl.append(" " + match[3]);
  }

  function showKey(detection) {
    if (!detection) {
      renderKeyName("");
      notesEl.textContent = "Play on your keyboard to detect the key.";
      confidenceEl.textContent = "";
      pianoEl.setAttribute("aria-label", "Piano keyboard. No scale highlighted yet.");
      for (const el of keyEls) {
        el.classList.remove("in-scale", "tonic");
        const label = el.querySelector(".key-label");
        label.textContent = el.classList.contains("black-key") ? "" : el.dataset.natural;
      }
      return;
    }

    const byPc = new Map(detection.notes.map((note) => [note.pc, note.label]));
    renderKeyName(detection.name);
    notesEl.textContent = detection.notes.map((note) => note.label).join("  ·  ");
    const match = Math.round(Math.max(0, detection.score) * 100);
    let detail = match + "% match";
    if (detection.runnerUp && detection.margin < 0.08) {
      detail += "  ·  also close: " + detection.runnerUp.name;
    }
    confidenceEl.textContent = detail;
    pianoEl.setAttribute(
      "aria-label",
      detection.name + " scale. Notes " + detection.notes.map((note) => note.label).join(", ")
    );

    for (const el of keyEls) {
      const pc = Number(el.dataset.pc);
      const inScale = byPc.has(pc);
      el.classList.toggle("in-scale", inScale);
      el.classList.toggle("tonic", inScale && pc === detection.tonic);
      const label = el.querySelector(".key-label");
      if (inScale) label.textContent = byPc.get(pc);
      else label.textContent = el.classList.contains("black-key") ? "" : el.dataset.natural;
    }
  }

  function consider(detection, now) {
    if (detection.score < MIN_SCORE) return;
    if (!shown) {
      if (heardMs < 700) return;
      shown = detection;
      showKey(detection);
      statusEl.textContent = "Listening.";
      return;
    }
    if (detection.tonic === shown.tonic && detection.mode === shown.mode) {
      pending = null;
      shown = detection;
      showKey(detection);
      return;
    }
    const samePending = pending && pending.tonic === detection.tonic && pending.mode === detection.mode;
    if (!samePending) {
      pending = detection;
      pendingSince = now;
      return;
    }
    if (now - pendingSince >= HOLD_MS && detection.margin >= 0.035) {
      shown = detection;
      pending = null;
      showKey(detection);
    }
  }

  function rmsOf(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function stop() {
    if (!audio) return;
    cancelAnimationFrame(audio.raf);
    audio.stream.getTracks().forEach((track) => track.stop());
    audio.context.close();
    audio = null;
    chroma = new Float64Array(12);
    pending = null;
    heardMs = 0;
    listenButton.textContent = "Start listening";
    listenButton.setAttribute("aria-pressed", "false");
    levelEl.style.transform = "scaleX(0)";
    statusEl.textContent = shown ? "Stopped. The last key is still shown." : "Microphone is off.";
  }

  async function start() {
    if (audio) {
      stop();
      return;
    }
    if (starting) return;
    starting = true;
    statusEl.textContent = "Waiting for microphone permission…";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (error) {
      starting = false;
      statusEl.textContent = "Couldn't use the microphone. Allow access and try again.";
      return;
    }

    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.82;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    source.connect(analyser);

    const freqDb = new Float32Array(analyser.frequencyBinCount);
    const timeData = new Float32Array(analyser.fftSize);
    chroma = new Float64Array(12);
    pending = null;
    heardMs = 0;
    shown = null;
    showKey(null);

    audio = { context, stream, analyser, raf: 0 };
    listenButton.textContent = "Stop listening";
    listenButton.setAttribute("aria-pressed", "true");
    statusEl.textContent = "Listening. Play along on your keyboard.";

    let last = 0;
    const loop = (now) => {
      audio.raf = requestAnimationFrame(loop);
      if (now - last < 100) return;
      const dt = last === 0 ? 100 : now - last;
      last = now;

      analyser.getFloatTimeDomainData(timeData);
      const rms = rmsOf(timeData);
      levelEl.style.transform = "scaleX(" + Math.min(1, rms * 12).toFixed(3) + ")";
      if (rms < SILENCE_RMS) {
        if (!shown) statusEl.textContent = "Listening. Waiting for audio.";
        return;
      }

      heardMs += dt;
      analyser.getFloatFrequencyData(freqDb);
      const frame = KeyFinder.chromaFromDecibels(freqDb, context.sampleRate);
      for (let i = 0; i < 12; i++) {
        chroma[i] = chroma[i] * (1 - SMOOTHING) + frame[i] * SMOOTHING;
      }
      consider(KeyFinder.estimateKey(chroma), now);
    };
    audio.raf = requestAnimationFrame(loop);
    starting = false;
  }

  buildPiano();
  listenButton.addEventListener("click", start);

  // Used by the page check to render a known detection without a microphone.
  window.__showDetection = function (tonic, mode, score) {
    const detection = {
      tonic: tonic,
      mode: mode,
      score: score == null ? 0.9 : score,
      margin: 0.2,
      name: KeyFinder.keyName(tonic, mode),
      notes: KeyFinder.spellScale(tonic, mode),
      runnerUp: null,
    };
    showKey(detection);
    return detection;
  };
})();
