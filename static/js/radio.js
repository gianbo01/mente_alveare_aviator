// ======== RADIO SINCRONIZZATA ESTERNA ========
(function () {
    const RADIO_OPEN_STORAGE_KEY = "aviator_radio_open";
    const MAX_SYNC_DRIFT_SECONDS = 2;
    const RADIO_BASE = String(window.RADIO_BASE || "http://localhost:5001").replace(/\/$/, "");

    const radioAudio = new Audio();
    let currentRadioFile = null;
    let currentPayload = null;
    let pendingRadioSeek = null;
    let radioUnlocked = false;
    let clockOffset = 0;

    const radioPanel = document.getElementById("radio-panel");
    const radioToggle = document.getElementById("radio-toggle");
    const radioTitle = document.getElementById("radio-title");
    const radioIndex = document.getElementById("radio-index");
    const radioProgress = document.getElementById("radio-progress");
    const radioPlayToggle = document.getElementById("radio-play-toggle");

    if (!radioPanel || !radioToggle || !window.io) return;

    const radioSocket = io(RADIO_BASE);

    initRadioPanel();
    requestRadioState();

    radioSocket.on("connect", requestRadioState);
    radioSocket.on("radio_state", syncRadio);
    radioSocket.on("radio_update", syncRadio);
    radioToggle.addEventListener("click", toggleRadioPanel);
    radioPlayToggle.addEventListener("click", toggleRadioPlayback);
    radioAudio.addEventListener("loadedmetadata", applyPendingSeek);
    radioAudio.addEventListener("play", updatePlayButton);
    radioAudio.addEventListener("pause", updatePlayButton);
    radioAudio.addEventListener("ended", requestRadioState);
    setInterval(updateRadioProgress, 1000);

    function initRadioPanel() {
        const isOpen = localStorage.getItem(RADIO_OPEN_STORAGE_KEY) === "true";

        radioAudio.volume = 0.7;
        setRadioPanelOpen(isOpen);
        updatePlayButton();
    }

    async function requestRadioState() {
        radioSocket.emit("request_state");

        try {
            const response = await fetch(`${RADIO_BASE}/api/radio/state`);
            if (response.ok) syncRadio(await response.json());
        } catch {
            showRadioUnavailable();
        }
    }

    function toggleRadioPanel() {
        setRadioPanelOpen(radioPanel.hidden);
    }

    function setRadioPanelOpen(isOpen) {
        radioPanel.hidden = !isOpen;
        radioPanel.classList.toggle("open", isOpen);
        radioToggle.setAttribute("aria-expanded", String(isOpen));
        localStorage.setItem(RADIO_OPEN_STORAGE_KEY, String(isOpen));
        window.aviatorAudio?.setMusicPlaying(isOpen && !radioAudio.paused);
    }

    function syncRadio(payload) {
        const track = normalizeRadioPayload(payload);
        if (!track.filename && !track.url) {
            currentPayload = null;
            currentRadioFile = null;
            radioAudio.removeAttribute("src");
            radioAudio.load();
            showRadioUnavailable();
            return;
        }

        currentPayload = payload;
        clockOffset = Number(payload.server_time || 0) - Date.now() / 1000;
        const offset = getRadioOffset(payload);

        if (track.source !== currentRadioFile) {
            currentRadioFile = track.source;
            radioAudio.src = track.source;
            seekRadioTo(offset);
            radioTitle.textContent = track.title;
            updateRadioIndex(track);

            if (radioUnlocked) playRadio();
            updateRadioProgress();
            return;
        }

        if (Math.abs(radioAudio.currentTime - offset) > MAX_SYNC_DRIFT_SECONDS) {
            seekRadioTo(offset);
        }

        updateRadioIndex(track);
        updateRadioProgress();
    }

    async function toggleRadioPlayback() {
        if (radioAudio.paused) {
            radioUnlocked = true;
            requestRadioState();
            await playRadio();
            return;
        }

        radioUnlocked = false;
        radioAudio.pause();
        window.aviatorAudio?.setMusicPlaying(false);
    }

    async function playRadio() {
        if (currentPayload) {
            const offset = getRadioOffset(currentPayload);
            if (Math.abs(radioAudio.currentTime - offset) > MAX_SYNC_DRIFT_SECONDS) {
                seekRadioTo(offset);
            }
        }

        try {
            await radioAudio.play();
            window.aviatorAudio?.setMusicPlaying(true);
        } catch {
            radioPlayToggle.textContent = "▶ Avvia Radio";
        }
    }

    function updatePlayButton() {
        radioPlayToggle.textContent = radioAudio.paused ? "▶ Avvia Radio" : "⏸ Pausa";
        if (radioAudio.paused) window.aviatorAudio?.setMusicPlaying(false);
    }

    function updateRadioProgress() {
        const duration = getPayloadDuration(currentPayload) || radioAudio.duration || 0;
        if (!duration) {
            radioProgress.style.width = "0%";
            return;
        }

        if (!radioAudio.paused && currentPayload) {
            const offset = getRadioOffset(currentPayload);
            if (Math.abs(radioAudio.currentTime - offset) > MAX_SYNC_DRIFT_SECONDS) {
                seekRadioTo(offset);
            }
        }

        const progress = Math.min(100, Math.max(0, radioAudio.currentTime / duration * 100));
        radioProgress.style.width = progress + "%";
    }

    function getRadioOffset(payload) {
        const estimatedServerNow = Date.now() / 1000 + clockOffset;
        const duration = getPayloadDuration(payload);
        const offset = Math.max(0, estimatedServerNow - Number(payload.started_at || 0));

        return duration ? Math.min(offset, Math.max(0, duration - 0.2)) : offset;
    }

    function seekRadioTo(offset) {
        pendingRadioSeek = offset;

        if (Number.isFinite(radioAudio.duration) && radioAudio.duration > 0) {
            applyPendingSeek();
        }
    }

    function applyPendingSeek() {
        if (pendingRadioSeek === null) return;

        const duration = getPayloadDuration(currentPayload) || radioAudio.duration || pendingRadioSeek;
        radioAudio.currentTime = Math.min(pendingRadioSeek, Math.max(0, duration - 0.2));
        pendingRadioSeek = null;
    }

    function updateRadioIndex(track) {
        const index = Number(track.index) || 0;
        const total = Number(track.total) || 0;
        radioIndex.textContent = `${index + 1} / ${total}`;
    }

    function normalizeRadioPayload(payload) {
        const track = payload?.track && typeof payload.track === "object" ? payload.track : {};
        const filename = payload?.filename || track.filename || (typeof payload?.track === "string" ? payload.track : "");
        const url = track.url || payload?.url || "";
        const source = buildRadioSource(url, filename);
        const title = track.title || payload?.title || formatRadioTitle(filename || url || "radio");

        return {
            filename,
            source,
            title,
            index: payload?.index ?? payload?.current_index ?? 0,
            total: payload?.total ?? payload?.playlist_length ?? 0
        };
    }

    function getPayloadDuration(payload) {
        return Number(payload?.duration || payload?.track?.duration || 0);
    }

    function buildRadioSource(url, filename) {
        if (url) {
            return /^https?:\/\//i.test(url) ? url : `${RADIO_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
        }

        return filename ? `${RADIO_BASE}/radio/${encodeRadioFilename(filename)}` : "";
    }

    function showRadioUnavailable() {
        radioTitle.textContent = "radio non disponibile";
        radioIndex.textContent = "0 / 0";
        radioProgress.style.width = "0%";
    }

    function encodeRadioFilename(filename) {
        return String(filename).split("/").map(encodeURIComponent).join("/");
    }

    function formatRadioTitle(filename) {
        return String(filename).replace(/\.mp3$/i, "").replace(/_/g, " ");
    }
})();
