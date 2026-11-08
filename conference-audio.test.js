/* Run with: node conference-audio.test.js
 * Lightweight routing tests for the isolated Electra conference mixer.
 * No microphone, browser, or production files are touched.
 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class FakeParam {
  constructor(value = 1) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}
class FakeNode {
  constructor() { this.connections = []; this.gain = new FakeParam(1); this.frequency = new FakeParam(440); this.type = ''; this.started = false; this.stopped = false; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class FakeAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.nodes = []; }
  node() { const n = new FakeNode(); this.nodes.push(n); return n; }
  createMediaStreamSource(stream) { const n = this.node(); n.stream = stream; return n; }
  createMediaStreamDestination() { const n = this.node(); n.stream = { id: 'generated-' + this.nodes.length }; return n; }
  createGain() { return this.node(); }
  createOscillator() { return this.node(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

const source = fs.readFileSync(new URL('./conference-audio.js', 'file://' + __filename), 'utf8');
let nextTimerId = 1;
const timers = new Map();
const sandbox = {
  window: { AudioContext: FakeAudioContext }, Map, Error,
  setInterval: fn => { const id = nextTimerId++; timers.set(id, fn); return id; },
  clearInterval: id => timers.delete(id)
};
vm.runInNewContext(source, sandbox, { filename: 'conference-audio.js' });
const Mixer = sandbox.window.ElectraConferenceAudio;
assert.equal(typeof Mixer, 'function', 'mixer class should be exposed');

const mixer = new Mixer({ id: 'host-mic' });
const caller1 = { id: 'caller-1-mic' };
const caller2 = { id: 'caller-2-mic' };
mixer.addParticipant('caller-1', caller1);
mixer.addParticipant('caller-2', caller2);
mixer.setPrivate('caller-1');
const out1 = mixer.outputFor('caller-1');
const out2 = mixer.outputFor('caller-2');

assert.equal(mixer.outputs.get('caller-1').hostGain.gain.value, 1, 'first caller should hear host immediately');
assert.equal(mixer.outputs.get('caller-1').hold, null, 'first caller must not receive hold music on initial connection');
const first = mixer.outputs.get('caller-1');
const second = mixer.outputs.get('caller-2');
assert.equal(first.hostGain.gain.value, 1, 'active caller 1 should hear host');
assert.equal(second.hostGain.gain.value, 0, 'held caller 2 must not hear host');
assert.equal(first.participantGains.get('caller-2').gain.value, 0, 'caller 1 must not hear caller 2 in private mode');
assert.equal(second.participantGains.get('caller-1').gain.value, 0, 'caller 2 must not hear caller 1 in private mode');
assert.equal(second.hold, null, 'held caller 2 should hear silence, not generated music');

mixer.setPrivate('caller-2');
assert.equal(first.hostGain.gain.value, 0, 'caller 1 should be held after switching');
assert.equal(second.hostGain.gain.value, 1, 'caller 2 should hear host after switching');
assert.equal(first.hold, null, 'held caller 1 should hear silence, not generated music');
assert.equal(second.hold, null, 'waiting music should stop for caller 2');

mixer.setConference();
assert.equal(first.hostGain.gain.value, 1, 'caller 1 should hear host in conference');
assert.equal(second.hostGain.gain.value, 1, 'caller 2 should hear host in conference');
assert.equal(first.participantGains.get('caller-2').gain.value, 1, 'caller 1 should hear caller 2 in conference');
assert.equal(second.participantGains.get('caller-1').gain.value, 1, 'caller 2 should hear caller 1 in conference');
assert.equal(first.hold, null, 'hold music should stop for caller 1 in conference');
assert.equal(second.hold, null, 'hold music should stop for caller 2 in conference');

mixer.removeParticipant('caller-2');
assert.equal(mixer.participants.has('caller-2'), false, 'disconnected caller should be removed');
mixer.dispose();
assert.equal(mixer.context.state, 'closed', 'dispose should close the audio context');

console.log('PASS: private switching, hold music routing, conference mixing, disconnect cleanup.');
