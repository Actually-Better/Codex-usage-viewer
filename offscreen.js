"use strict";

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "capacity:playSound") return false;
  playAlertTone().catch(() => {});
  return false;
});

async function playAlertTone() {
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(740, start);
  oscillator.frequency.setValueAtTime(880, start + 0.12);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.3);
  oscillator.addEventListener("ended", () => context.close(), { once: true });
}
