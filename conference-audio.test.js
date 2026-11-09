/* Run with: node conference-audio.test.js
 * Lightweight routing tests for the isolated Electra conference mixer.
 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class FakeParam {
  constructor(value = 1) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
}
class FakeNode {
  constructor() { this.connections = []; this.gain = new FakeParam(1); this.started = false; this.stopped = false; }
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
  createBufferSource() { return this.node(); }
  decodeAudioData() { return Promise.resolve({ duration: 180 }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

(async () => {
  const source = fs.readFileSync(new URL('./conference-audio.js', 'file://' + __filename), 'utf8');
  const fetched = [];
  const sandbox = {
    window: { AudioContext: FakeAudioContext }, Map, Error, Math, console,
    fetch: url => { fetched.push(url); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }); }
  };
  vm.runInNewContext(source, sandbox, { filename: 'conference-audio.js' });
  const Mixer = sandbox.window.ElectraConferenceAudio;
  assert.equal(typeof Mixer, 'function', 'mixer class should be exposed');

  const mixer = new Mixer({ id: 'host-mic' });
  // Match the real PeerJS order: Caller 1's output is created before their
  // stream arrives; Caller 2's output is created after Caller 1 is connected.
  mixer.outputFor('caller-1');
  mixer.addParticipant('caller-1', { id: 'caller-1-mic' });
  mixer.setPrivate('caller-1');
  mixer.outputFor('caller-2');
  mixer.addParticipant('caller-2', { id: 'caller-2-mic' });
  await new Promise(resolve => setTimeout(resolve, 0));

  const first = mixer.outputs.get('caller-1');
  const second = mixer.outputs.get('caller-2');
  assert.equal(first.hostGain.gain.value, 1, 'active caller 1 should hear host');
  assert.equal(second.hostGain.gain.value, 0, 'held caller 2 must not hear host');
  assert.equal(first.hold, null, 'active caller 1 must not hear hold music');
  assert.ok(second.hold?.source?.started, 'held caller 2 should receive a music track');
  assert.ok(second.hold.source.connections[0] === second.hold.gain, 'music should route through its own gain node');
  assert.ok(second.hold.gain.connections.includes(second.destination), 'music should route only into caller 2 output');
  assert.equal(first.participantGains.get('caller-2').gain.value, 0, 'caller 1 must not hear caller 2 in private mode');
  assert.equal(second.participantGains.get('caller-1').gain.value, 0, 'caller 2 must not hear caller 1 in private mode');
  assert.ok(mixer.participants.get('caller-2').source.connections.includes(first.participantGains.get('caller-2')), 'caller 2 source must feed caller 1 output');
  assert.ok(first.participantGains.get('caller-2').connections.includes(first.destination), 'caller 2 audio must reach caller 1 destination');
  assert.ok(mixer.participants.get('caller-1').source.connections.includes(second.participantGains.get('caller-1')), 'caller 1 source must feed caller 2 output');
  assert.ok(second.participantGains.get('caller-1').connections.includes(second.destination), 'caller 1 audio must reach caller 2 destination');

  mixer.setPrivate('caller-2');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(first.hostGain.gain.value, 0, 'caller 1 should be held after switching');
  assert.equal(second.hostGain.gain.value, 1, 'caller 2 should hear host after switching');
  assert.equal(second.hold, null, 'hold music should stop for caller 2 when host talks to them');
  assert.ok(first.hold?.source?.started, 'hold music should move to caller 1');
  assert.equal(fetched.length, 2, 'a new hold session should choose and fetch another track');
  assert.notEqual(fetched[0], fetched[1], 'the same track should not play twice in a row');

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
  console.log('PASS: private switching, randomized hold music routing, conference mixing, disconnect cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
