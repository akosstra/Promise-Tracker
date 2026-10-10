// Runs inside the offscreen document. Captures the meeting tab's audio and,
// optionally, the user's microphone. Each source is a "channel" that is
// recorded in short self-contained chunks and sent to the configured
// transcription endpoint. Tab audio is labelled "others", mic audio "you".
// The background worker drives start/stop; this file never tears itself down,
// it only asks the worker to (via "transcription:ended").

const TAB_SILENCE_PEAK = 4; // 0-128 scale; quieter chunks are skipped
const MIC_SILENCE_PEAK = 8; // mics have a higher noise floor
const MIN_CHUNK_MS = 800;
const MAX_FAILURES = 3;
const FILLER_RE = /^(?:thanks? for watching|thank you(?: for watching)?|you|bye)[.! ]*$/i;

let capture = null;

function notify(message) {
  return chrome.runtime.sendMessage({ target: "background", ...message }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  const run =
    message.type === "start"
      ? startCapture(message)
      : message.type === "stop"
        ? stopCapture()
        : Promise.resolve({ ok: false, error: "Unknown message" });
  run.then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function startCapture({ streamId, sessionId, settings, includeMic }) {
  if (capture) return { ok: false, error: "Already capturing audio." };

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });

  const context = new AudioContext();
  await context.resume();
  const state = { sessionId, settings, context, channels: [], running: true, failures: 0, reportedEnd: false };
  capture = state;

  // Capturing a tab mutes it for the user; playback:true routes it back out.
  addChannel(state, { speaker: "others", stream: tabStream, silencePeak: TAB_SILENCE_PEAK, playback: true });

  let warning = null;
  if (includeMic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      addChannel(state, { speaker: "you", stream: micStream, silencePeak: MIC_SILENCE_PEAK, playback: false });
    } catch (error) {
      warning = `Microphone unavailable (${error?.name || "error"}). Transcribing the tab only.`;
    }
  }

  return { ok: true, warning };
}

function addChannel(state, { speaker, stream, silencePeak, playback }) {
  const source = state.context.createMediaStreamSource(stream);
  const analyser = state.context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  if (playback) source.connect(state.context.destination);

  const channel = {
    state,
    speaker,
    stream,
    silencePeak,
    recorder: null,
    timer: null,
    meter: null,
    peak: 0,
    running: true,
    queue: Promise.resolve(),
  };
  state.channels.push(channel);

  const samples = new Uint8Array(analyser.fftSize);
  channel.meter = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    for (const value of samples) channel.peak = Math.max(channel.peak, Math.abs(value - 128));
  }, 100);

  stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (capture !== state || !channel.running) return;
    if (speaker === "others") {
      notify({ type: "transcription:ended" });
    } else {
      // Mic unplugged mid-meeting: drop that channel, keep transcribing the tab.
      retireChannel(channel);
      notify({
        type: "transcription:error",
        sessionId: state.sessionId,
        error: "Microphone disconnected. Still transcribing the tab.",
      });
    }
  });

  recordChunk(channel);
}

function retireChannel(channel) {
  channel.running = false;
  clearTimeout(channel.timer);
  clearInterval(channel.meter);
  channel.stream.getTracks().forEach((track) => track.stop());
}

// Each chunk is its own MediaRecorder so every upload is a complete file.
function recordChunk(channel) {
  const recorder = new MediaRecorder(channel.stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 32000,
  });
  const parts = [];
  const startedAt = Date.now();
  channel.peak = 0;
  channel.recorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) parts.push(event.data);
  });

  recorder.addEventListener("stop", () => {
    clearTimeout(channel.timer);
    const chunk = {
      blob: new Blob(parts, { type: "audio/webm" }),
      startedAt,
      durationMs: Date.now() - startedAt,
      peak: channel.peak,
    };
    channel.queue = channel.queue.then(() => transcribeChunk(channel, chunk));
    // stream.active guards against a tight loop if the source has ended.
    if (channel.running && channel.stream.active) recordChunk(channel);
  });

  recorder.start();
  channel.timer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, channel.state.settings.chunkSeconds * 1000);
}

async function transcribeChunk(channel, chunk) {
  if (chunk.durationMs < MIN_CHUNK_MS || chunk.peak < channel.silencePeak) return;

  const { state } = channel;
  const { endpoint, apiKey, model, language } = state.settings;
  const body = new FormData();
  body.append("file", chunk.blob, "chunk.webm");
  body.append("model", model);
  body.append("response_format", "json");
  if (language) body.append("language", language);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body,
    });
    if (!response.ok) throw new Error(`Transcription request failed (${response.status})`);

    const raw = await response.text();
    let text = raw;
    try {
      text = JSON.parse(raw).text ?? "";
    } catch {
      /* some servers return plain text */
    }

    state.failures = 0;
    text = String(text).trim();
    if (text && !FILLER_RE.test(text)) {
      await notify({
        type: "transcription:segment",
        sessionId: state.sessionId,
        text,
        at: chunk.startedAt,
        speaker: channel.speaker,
      });
    }
  } catch (error) {
    state.failures += 1;
    const message = error?.message || String(error);
    await notify({ type: "transcription:error", sessionId: state.sessionId, error: message });
    if (state.failures >= MAX_FAILURES && !state.reportedEnd) {
      state.reportedEnd = true;
      notify({ type: "transcription:ended", error: message });
    }
  }
}

async function stopCapture() {
  const state = capture;
  if (!state) return { ok: true };

  state.running = false;

  // Flush each in-progress chunk so the last few seconds aren't lost.
  await Promise.all(
    state.channels.map(async (channel) => {
      channel.running = false;
      clearTimeout(channel.timer);
      if (channel.recorder?.state === "recording") {
        await new Promise((resolve) => {
          channel.recorder.addEventListener("stop", resolve, { once: true });
          channel.recorder.stop();
        });
      }
      await channel.queue;
      clearInterval(channel.meter);
      channel.stream.getTracks().forEach((track) => track.stop());
    }),
  );

  try {
    await state.context.close();
  } catch {
    /* already closed */
  }
  capture = null;
  return { ok: true };
}
