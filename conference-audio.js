/* Electra Explains — conference audio mixer for the isolated merge repository.
 * Hold music is routed only to the caller currently on hold.
 */
(() => {
  'use strict';

  const HOLD_MUSIC_TRACKS = [
    // Purrple Cat — CC BY 4.0; licensed for streams and commercial use with credit.
    'https://purrplecat-audio.pages.dev/audio/city-nights-3/01-fog-blanket.mp3',
    'https://purrplecat-audio.pages.dev/audio/city-nights-3/03-window-seat.mp3',
    'https://purrplecat-audio.pages.dev/audio/city-nights-3/04-corner-store.mp3',
    'https://purrplecat-audio.pages.dev/audio/city-nights-3/08-half-awake.mp3',
    'https://purrplecat-audio.pages.dev/audio/city-nights-3/13-empty-sidewalks.mp3'
  ];

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
      this.trackBuffers = new Map();
      this.lastHoldTrackIndex = -1;
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
      // A held caller hears one of five softly mixed instrumental tracks.
      // Music is routed only to that caller's outgoing stream, never to the
      // host or the caller who is currently speaking.
      if (output.hold || this.disposed) return;
      const hold = { source: null, gain: null, cancelled: false };
      output.hold = hold;

      let index = Math.floor(Math.random() * HOLD_MUSIC_TRACKS.length);
      if (HOLD_MUSIC_TRACKS.length > 1 && index === this.lastHoldTrackIndex) {
        index = (index + 1 + Math.floor(Math.random() * (HOLD_MUSIC_TRACKS.length - 1))) % HOLD_MUSIC_TRACKS.length;
      }
      this.lastHoldTrackIndex = index;
      const url = HOLD_MUSIC_TRACKS[index];

      let bufferPromise = this.trackBuffers.get(url);
      if (!bufferPromise) {
        bufferPromise = fetch(url, { mode: 'cors' })
          .then(response => {
            if (!response.ok) throw new Error('Hold music download failed.');
            return response.arrayBuffer();
          })
          .then(data => this.context.decodeAudioData(data));
        this.trackBuffers.set(url, bufferPromise);
      }

      bufferPromise.then(buffer => {
        if (this.disposed || hold.cancelled || output.hold !== hold) return;
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        source.buffer = buffer;
        source.loop = true;
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(output.destination);
        hold.source = source;
        hold.gain = gain;
        source.start();
        gain.gain.setTargetAtTime(0.14, this.context.currentTime, 0.8);
      }).catch(error => {
        if (output.hold === hold) output.hold = null;
        console.warn('Electra hold music unavailable; keeping the line silent.', error);
      });
    }

    _stopHoldMusic(output) {
      const hold = output.hold;
      if (!hold) return;
      hold.cancelled = true;
      if (hold.gain) {
        try { hold.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.035); } catch {}
      }
      if (hold.source) {
        try { hold.source.stop(this.context.currentTime + 0.12); } catch {}
        try { hold.source.disconnect(); } catch {}
      }
      if (hold.gain) {
        try { hold.gain.disconnect(); } catch {}
      }
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