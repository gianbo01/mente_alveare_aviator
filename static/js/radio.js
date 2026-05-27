// ======== RADIO SINCRONIZZATA ========
(function () {
    const RADIO_OPEN_STORAGE_KEY = "aviator_radio_open";
    const MAX_SYNC_DRIFT_SECONDS = 2;

    const radioAudio = new Audio();
    let currentRadioFile = null;
    let currentPayload = null;
    let currentPayloadReceivedAt = 0;
    let pendingRadioSeek = null;
    let radioUnlocked = false;

    const socket = window.aviatorSocket || io();
    window.aviatorSocket = socket;

    const radioPanel = document.getElementById("radio-panel");
    const radioToggle = document.getElementById("radio-toggle");
    const radioTitle = document.getElementById("radio-title");
    const radioIndex = document.getElementById("radio-index");
    const radioProgress = document.getElementById("radio-progress");
    const radioPlayToggle = document.getElementById("radio-play-toggle");

    if (!radioPanel || !radioToggle) return;

    initRadioPanel();

    socket.on("radio_state", syncRadio);
    socket.on("radio_update", syncRadio);
    radioToggle.addEventListener("click", toggleRadioPanel);
    radioPlayToggle.addEventListener("click", toggleRadioPlayback);
    radioAudio.addEventListener("loadedmetadata", applyPendingSeek);
    radioAudio.addEventListener("play", updatePlayButton);
    radioAudio.addEventListener("pause", updatePlayButton);
    setInterval(updateRadioProgress, 1000);

    function initRadioPanel() {
        const isOpen = localStorage.getItem(RADIO_OPEN_STORAGE_KEY) === "true";

        radioAudio.volume = 0.7;
        setRadioPanelOpen(isOpen);
        updatePlayButton();
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
        if (!payload || !payload.filename) {
            currentPayload = null;
            currentRadioFile = null;
            radioTitle.textContent = "nessun brano";
            radioIndex.textContent = "0 / 0";
            radioProgress.style.width = "0%";
            return;
        }

        currentPayload = payload;
        currentPayloadReceivedAt = Date.now() / 1000;
        const offset = getRadioOffset(payload);

        if (payload.filename !== currentRadioFile) {
            currentRadioFile = payload.filename;
            radioAudio.src = "/radio/" + encodeRadioFilename(payload.filename);
            seekRadioTo(offset);
            radioTitle.textContent = formatRadioTitle(payload.filename);
            radioIndex.textContent = `${Number(payload.index) + 1} / ${payload.total}`;

            if (radioUnlocked) playRadio();
            updateRadioProgress();
            return;
        }

        if (Math.abs(radioAudio.currentTime - offset) > MAX_SYNC_DRIFT_SECONDS) {
            seekRadioTo(offset);
        }

        radioIndex.textContent = `${Number(payload.index) + 1} / ${payload.total}`;
        updateRadioProgress();
    }

    async function toggleRadioPlayback() {
        radioUnlocked = true;

        if (radioAudio.paused) {
            socket.emit("radio_request_state");
            await playRadio();
            return;
        }

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
        const duration = Number(currentPayload?.duration) || radioAudio.duration || 0;
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
        const payloadAge = currentPayloadReceivedAt ? Date.now() / 1000 - currentPayloadReceivedAt : 0;
        const estimatedServerNow = Number(payload.server_time) + payloadAge;
        const duration = Number(payload.duration) || 0;
        const offset = Math.max(0, estimatedServerNow - Number(payload.started_at));

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

        const duration = Number(currentPayload?.duration) || radioAudio.duration || pendingRadioSeek;
        radioAudio.currentTime = Math.min(pendingRadioSeek, Math.max(0, duration - 0.2));
        pendingRadioSeek = null;
    }

    function encodeRadioFilename(filename) {
        return String(filename).split("/").map(encodeURIComponent).join("/");
    }

    function formatRadioTitle(filename) {
        return String(filename).replace(/\.mp3$/i, "").replace(/_/g, " ");
    }
})();
