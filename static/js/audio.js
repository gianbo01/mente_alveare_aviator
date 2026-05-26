// ======== AUDIO GENERATO VIA WEB AUDIO API ========
// Tutti i suoni vengono creati al volo, senza file audio esterni.
(function () {
    let audioContext = null;
    let muted = localStorage.getItem("aviator_audio_muted") === "true";
    let lastTickerTime = 0;

    function init() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioContext.state === "suspended") {
            audioContext.resume();
        }
    }

    function isReady() {
        return audioContext && audioContext.state === "running" && !muted;
    }

    function playTone(frequency, duration, type = "sine", volume = 0.05, startOffset = 0) {
        if (!isReady()) return;

        const now = audioContext.currentTime + startOffset;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
    }

    function playBetClick() {
        init();
        playTone(880, 0.045, "square", 0.035);
    }

    function playTicker(multiplier) {
        if (!isReady()) return;

        const nowMs = performance.now();
        if (nowMs - lastTickerTime < 170) return;
        lastTickerTime = nowMs;

        const frequency = Math.min(760, 210 + multiplier * 48);
        playTone(frequency, 0.035, "sine", 0.018);
    }

    function playCrash() {
        if (!isReady()) return;

        const duration = 0.34;
        const sampleRate = audioContext.sampleRate;
        const buffer = audioContext.createBuffer(1, sampleRate * duration, sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < data.length; i++) {
            const decay = 1 - i / data.length;
            data[i] = (Math.random() * 2 - 1) * decay * 0.65;
        }

        const source = audioContext.createBufferSource();
        const filter = audioContext.createBiquadFilter();
        const gain = audioContext.createGain();
        const now = audioContext.currentTime;

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(420, now);
        filter.frequency.exponentialRampToValueAtTime(90, now + duration);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        source.buffer = buffer;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(audioContext.destination);
        source.start(now);
    }

    function playCashout() {
        init();
        playTone(523.25, 0.12, "triangle", 0.045);
        playTone(659.25, 0.16, "triangle", 0.05, 0.11);
    }

    function toggleMute() {
        muted = !muted;
        localStorage.setItem("aviator_audio_muted", String(muted));
        updateMuteButton();
        if (!muted) init();
        return muted;
    }

    function isMuted() {
        return muted;
    }

    function updateMuteButton() {
        const muteButton = document.getElementById("mute-toggle");
        if (!muteButton) return;

        muteButton.textContent = muted ? "🔇" : "🔊";
        muteButton.classList.toggle("muted", muted);
        muteButton.setAttribute("aria-pressed", String(muted));
    }

    document.addEventListener("DOMContentLoaded", () => {
        updateMuteButton();

        const muteButton = document.getElementById("mute-toggle");
        if (muteButton) {
            muteButton.addEventListener("click", () => {
                init();
                toggleMute();
            });
        }
    });

    window.aviatorAudio = {
        init,
        toggleMute,
        isMuted,
        playBetClick,
        playTicker,
        playCrash,
        playCashout
    };
})();
