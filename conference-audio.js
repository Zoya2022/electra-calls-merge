/* Electra Explains — isolated conference audio mixer.
 * This file is experimental and is only used by call-merge-test.
 * It does not change the production main branch.
 */
(() => {
  'use strict';

  class ElectraConferenceAudio {
    constructor(hostStream) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio is not supported in this browser.');
      this.context = new AudioContextClass();
      this.hostSource = this.context.createMediaStreamSource(hostStream);
      this.participants = new Map();
      this.outputs = new Map();
      this.mode = 'private';
      this.activeId = null;
      this.disposed = false;
    }

    async resume() {
      if (this.context.state === 'suspended') await this.context.resume();
    }

    addParticipant(id, stream) {
      this.removeParticipant(id);
      const source = this.context.createMediaStreamSource(stream);
      this.participants.set(id, { stream, source });
      for (const [targetId, output] of this.outputs) {
        this._connectParticipant(id, targetId, output);
      }
      this._applyMode();
    }

    removeParticipant(id) {
      const participant = this.participants.get(id);
      if (!participant) return;
      for (const output of this.outputs.values()) {
        const gain = output.participantGains.get(id);
        if (gain) {
          try { gain.disconnect(); } catch {}
          output.participantGains.delete(id);
        }
      }
      try { participant.source.disconnect(); } catch {}
      this.participants.delete(id);
      if (this.activeId === id) this.activeId = null;
      this._applyMode();
    }

    _connectParticipant(id, targetId, output) {
      if (id === targetId || output.participantGains.has(id)) return;
      const participant = this.participants.get(id);
      if (!participant) return;
      const gain = this.context.createGain();
      gain.gain.value = 0;
      participant.source.connect(gain);
      gain.connect(output.destination);
      output.participantGains.set(id, gain);
    }

    _makeOutput(targetId) {
      const destination = this.context.createMediaStreamDestination();
      const hostGain = this.context.createGain();
      hostGain.gain.value = 1;
      this.hostSource.connect(hostGain);
      hostGain.connect(destination);
      const output = { destination, hostGain, participantGains: new Map(), hold: null };
      this.outputs.set(targetId, output);
      for (const id of this.participants.keys()) this._connectParticipant(id, targetId, output);
      return output;
    }

    outputFor(targetId) {
      const output = this.outputs.get(targetId) || this._makeOutput(targetId);
      this._applyMode();
      return output.destination.stream;
    }

    setPrivate(activeParticipantId) {
      this.mode = 'private';
      this.activeId = activeParticipantId;
      this._applyMode();
    }

    setConference() {
      this.mode = 'conference';
      this.activeId = null;
      this._applyMode();
    }

    _applyMode() {
      const now = this.context.currentTime;
      for (const [targetId, output] of this.outputs) {
        const held = this.mode === 'private' && targetId !== this.activeId;
        output.hostGain.gain.setTargetAtTime(held ? 0 : 1, now, 0.025);
        for (const [participantId, gain] of output.participantGains) {
          const include = this.mode === 'conference' && participantId !== targetId;
          gain.gain.setTargetAtTime(include ? 1 : 0, now, 0.025);
        }
        if (held) this._startHoldMusic(output);
        else this._stopHoldMusic(output);
      }
    }

    _startHoldMusic(output) {
      // No generated audio on held lines. A held caller hears silence only;
      // this avoids any tone/music being mistaken for call audio.
      return;
    }

    _stopHoldMusic(output) {
      if (!output.hold) return;
      clearInterval(output.hold.phraseTimer);
      for (const oscillator of output.hold.oscillators || []) {
        try { oscillator.stop(); oscillator.disconnect(); } catch {}
      }
      try { output.hold.envelope?.disconnect(); } catch {}
      try { output.hold.source?.disconnect(); } catch {}
      try { output.hold.master?.disconnect(); } catch {}
      output.hold = null;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const output of this.outputs.values()) {
        this._stopHoldMusic(output);
        try { output.hostGain.disconnect(); } catch {}
        for (const gain of output.participantGains.values()) {
          try { gain.disconnect(); } catch {}
        }
      }
      for (const participant of this.participants.values()) {
        try { participant.source.disconnect(); } catch {}
      }
      try { this.hostSource.disconnect(); } catch {}
      this.outputs.clear();
      this.participants.clear();
      this.context.close().catch(() => {});
    }
  }

  window.ElectraConferenceAudio = ElectraConferenceAudio;
})();