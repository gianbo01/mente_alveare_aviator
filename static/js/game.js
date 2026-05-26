// ======== VARIABILI GIOCO ========
let running = false;
let crashed = false;
let currentMultiplier = 1.0;
let intervalId = null;
let countdownId = null;
let countdownActive = false;

let lastCashout = null;

const INITIAL_BALANCE = 1000;
const USER_STORAGE_KEY = "aviator_user";
const BALANCE_STORAGE_KEY = "aviator_balance";
const HISTORY_STORAGE_KEY = "aviator_round_history";
const BEST_CASHOUT_STORAGE_KEY = "aviator_best_cashout";
const GAMES_PLAYED_STORAGE_KEY = "aviator_games_played";
const GAMES_WON_STORAGE_KEY = "aviator_games_won";
const TOTAL_WON_STORAGE_KEY = "aviator_total_won";
const LEADERBOARD_ENTRY_STORAGE_KEY = "aviator_leaderboard_entry";
const MAX_HISTORY_ITEMS = 50;
const MAX_VISIBLE_HISTORY_ITEMS = 10;
const MIN_AUTO_CASHOUT = 1.01;
const MULTIPLIER_GROWTH = 1.012;

let currentUser = loadUser();
let balance = loadBalance();
let currentBet = 0;
let roundHistory = loadRoundHistory();
let bestCashout = loadBestCashout();
let gamesPlayed = loadStoredNumber(GAMES_PLAYED_STORAGE_KEY);
let gamesWon = loadStoredNumber(GAMES_WON_STORAGE_KEY);
let totalWon = loadStoredNumber(TOTAL_WON_STORAGE_KEY);
let autoCashoutThreshold = null;
let currentRoundId = null;
let revealedCrashPoint = null;
let pendingHistoryRecordId = null;
let roundPhase = null;
let roundStartedAt = null;
let serverTimeOffset = 0;
let acceptingBets = false;
let hasActiveBet = false;
let hasCashedOut = false;
let globalHistory = [];
let previousPlayerStates = new Map();

const multiplierEl = document.getElementById("multiplier-value");
const statusEl = document.getElementById("status-text");
const startBtn = document.getElementById("start-btn");
const cashoutBtn = document.getElementById("cashout-btn");
const balanceEl = document.getElementById("balance-value");
const headerNicknameEl = document.getElementById("header-nickname");
const headerBalanceEl = document.getElementById("header-balance");
const betInput = document.getElementById("bet-input");
const autoCashoutEnabled = document.getElementById("auto-cashout-enabled");
const autoCashoutInput = document.getElementById("auto-cashout-input");
const autoCashoutStatus = document.getElementById("auto-cashout-status");
const currentBetEl = document.getElementById("current-bet");
const lastResultEl = document.getElementById("last-result");
const historyListEl = document.getElementById("history-list");
const globalHistoryListEl = document.getElementById("global-history-list");
const lastCashoutEl = document.getElementById("last-cashout");
const bestCashoutEl = document.getElementById("best-cashout");
const vanContainer = document.getElementById("van");
const vanImg = document.getElementById("van-img");
const flightStageEl = document.querySelector(".flight-stage");
const betPanelEl = document.querySelector(".bet-panel");
const welcomeModal = document.getElementById("welcome-modal");
const welcomeForm = document.getElementById("welcome-form");
const nicknameInput = document.getElementById("nickname-input");
const settingsToggle = document.getElementById("settings-toggle");
const settingsMenu = document.getElementById("settings-menu");
const resetAccountBtn = document.getElementById("reset-account-btn");
const playersCountEl = document.getElementById("players-count");
const playersListEl = document.getElementById("players-list");

initSessionUI();
updateWalletUI();
updateAutoCashoutUI();
renderRoundHistory();


// ======== CANVAS SCIA ========
const canvas = document.getElementById("trail-canvas");
const ctx = canvas.getContext("2d");
const chartPadding = { top: 22, right: 18, bottom: 32, left: 46 };

function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    if (typeof trailPoints !== "undefined") {
        drawChart();
        if (!running) resetVanPosition();
    }
}
window.addEventListener("resize", resizeCanvas);

let trailPoints = [];
let time = 0;

resizeCanvas();
drawChart();
resetVanPosition();


// ======== ROUND ========
startBtn.addEventListener("click", startRound);
cashoutBtn.addEventListener("click", cashout);
betInput.addEventListener("input", updateBetInputLimits);
autoCashoutEnabled.addEventListener("change", updateAutoCashoutUI);
autoCashoutInput.addEventListener("input", updateAutoCashoutUI);
welcomeForm.addEventListener("submit", handleWelcomeSubmit);
settingsToggle.addEventListener("click", toggleSettingsMenu);
resetAccountBtn.addEventListener("click", resetAccount);

const socket = io();

socket.on("connect", () => {
    socket.emit("join");
    socket.emit("player_join", { nickname: getCurrentNickname() });
});

socket.on("round_state", handleRoundState);
socket.on("round_start", handleRoundStart);
socket.on("tick", handleServerTick);
socket.on("crash", handleServerCrash);
socket.on("players_update", data => renderPlayersPanel(data.players || []));

function startRound() {
    if (running || countdownActive) return;
    if (!acceptingBets || !currentRoundId) {
        statusEl.textContent = "round già in corso, attendi il prossimo";
        return;
    }

    const bet = getValidatedBet();
    if (!bet) return;

    const requestedAutoCashout = autoCashoutEnabled.checked ? getAutoCashoutValue() : null;
    if (autoCashoutEnabled.checked && !requestedAutoCashout) return;

    window.aviatorAudio?.init();
    window.aviatorAudio?.playBetClick();

    revealedCrashPoint = null;
    pendingHistoryRecordId = null;
    currentBet = bet;
    autoCashoutThreshold = requestedAutoCashout;
    hasActiveBet = true;
    hasCashedOut = false;
    balance -= currentBet;
    saveBalance();
    socket.emit("player_bet", { bet: currentBet });

    statusEl.textContent = `puntata piazzata, partenza tra ${getStartCountdown()}s`;
    startBtn.disabled = true;
    cashoutBtn.disabled = true;
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;
    currentBetEl.textContent = formatCoins(currentBet) + " monete";
    lastResultEl.textContent = "-";
    updateWalletUI();
    updateAutoCashoutUI();
}

function handleRoundState(data) {
    syncServerClock(data.server_time);
    globalHistory = Array.isArray(data.round_history) ? data.round_history : [];
    renderGlobalHistory();
    renderPlayersPanel(data.players || []);
    currentRoundId = data.round_id;
    roundStartedAt = data.started_at;
    currentMultiplier = Number(data.multiplier_now) || 1;
    roundPhase = data.active ? (isBettingWindowOpen() ? "betting" : "running") : "crashed";
    acceptingBets = data.active && isBettingWindowOpen() && !hasActiveBet && !hasCashedOut;
    resetRound(currentMultiplier);

    if (!data.active) {
        revealedCrashPoint = Number(data.crash_point) || null;
        statusEl.textContent = "round terminato, attendi il prossimo";
        startBtn.disabled = true;
        return;
    }

    updateLiveRoundUI();
}

function handleRoundStart(data) {
    syncServerClock(data.server_time);
    clearInterval(intervalId);
    clearInterval(countdownId);
    countdownActive = false;
    currentRoundId = data.round_id;
    roundStartedAt = data.started_at;
    currentMultiplier = 1;
    time = 0;
    running = false;
    crashed = false;
    roundPhase = "betting";
    acceptingBets = true;
    hasActiveBet = false;
    hasCashedOut = false;
    pendingHistoryRecordId = null;
    revealedCrashPoint = null;
    currentBet = 0;
    autoCashoutThreshold = null;
    currentBetEl.textContent = "-";
    lastResultEl.textContent = "-";
    resetRound(1);
    multiplierEl.classList.remove("running", "crashed", "cashed-out");
    vanContainer.classList.remove("flying", "crashed");
    vanImg.classList.remove("flying", "crashed");
    betInput.disabled = false;
    autoCashoutEnabled.disabled = false;
    autoCashoutInput.disabled = false;
    cashoutBtn.disabled = true;
    statusEl.classList.remove("countdown");
    statusEl.textContent = `puntate aperte, partenza tra ${getStartCountdown()}s`;
    updateWalletUI();
    updateAutoCashoutUI();
}

function handleServerTick(data) {
    if (data.round_id !== currentRoundId) return;

    syncServerClock(data.server_time);
    currentMultiplier = Number(data.multiplier) || 1;
    time = estimateTimeForMultiplier(currentMultiplier);
    roundPhase = isBettingWindowOpen() ? "betting" : "running";
    acceptingBets = roundPhase === "betting" && !hasActiveBet && !hasCashedOut;

    renderSpectatorFrame();

    if (hasActiveBet && !hasCashedOut && handleBettingTick()) return;

    updateLiveRoundUI();
}

function handleServerCrash(data) {
    if (data.round_id !== currentRoundId) return;

    syncServerClock(data.server_time);
    revealedCrashPoint = Number(data.crash_point) || currentMultiplier;
    globalHistory = Array.isArray(data.round_history) ? data.round_history : globalHistory;
    renderGlobalHistory(true);
    acceptingBets = false;
    roundPhase = "crashed";

    if (hasActiveBet && !hasCashedOut) {
        crash(revealedCrashPoint);
        return;
    }

    showSpectatorCrash(revealedCrashPoint);

    if (hasCashedOut && pendingHistoryRecordId) {
        updateHistoryCrashPoint(pendingHistoryRecordId, revealedCrashPoint);
        pendingHistoryRecordId = null;
    }

    statusEl.textContent = `crash a ${revealedCrashPoint.toFixed(2)}x, prossimo round in 5s`;
    startNextRoundCountdown();
}

function renderSpectatorFrame() {
    updateMultiplier();

    if (roundPhase === "running") {
        multiplierEl.classList.add("running");
        vanContainer.classList.add("flying");
        vanImg.classList.add("flying");
        window.aviatorAudio?.playTicker(currentMultiplier);
    }

    addCurrentPointToChart();
}

function handleBettingTick() {
    running = roundPhase === "running";
    cashoutBtn.disabled = roundPhase !== "running";

    if (roundPhase === "running" && autoCashoutThreshold && currentMultiplier >= autoCashoutThreshold) {
        cashout();
        return true;
    }

    return false;
}

function showSpectatorCrash(crashPoint) {
    currentMultiplier = Number(crashPoint) || currentMultiplier;
    updateMultiplier();
    multiplierEl.classList.remove("running", "cashed-out");
    multiplierEl.classList.add("crashed");
    vanContainer.classList.remove("flying");
    vanContainer.classList.add("crashed");
    vanImg.classList.remove("flying");
    vanImg.classList.add("crashed");
    window.aviatorAudio?.playCrash();
    triggerCrashFlash();
}

function resetRound(initialMultiplier = 1) {
    currentMultiplier = initialMultiplier;
    time = estimateTimeForMultiplier(initialMultiplier);
    trailPoints = [];
    const { x, y } = getPointForState(time, currentMultiplier);
    trailPoints.push({ time, multiplier: currentMultiplier, x, y });
    drawChart();
    moveVan(x, y);
    updateMultiplier();
}

function addCurrentPointToChart() {
    const { x, y } = getPointForState(time, currentMultiplier);

    trailPoints.push({ time, multiplier: currentMultiplier, x, y });
    drawChart();
    moveVan(x, y);
}

function syncServerClock(serverTime) {
    if (!Number.isFinite(Number(serverTime))) return;
    serverTimeOffset = Number(serverTime) - Date.now() / 1000;
}

function getServerNow() {
    return Date.now() / 1000 + serverTimeOffset;
}

function isBettingWindowOpen() {
    return roundStartedAt && getServerNow() < roundStartedAt;
}

function getStartCountdown() {
    if (!roundStartedAt) return 0;
    return Math.max(0, Math.ceil(roundStartedAt - getServerNow()));
}

function updateLiveRoundUI() {
    if (roundPhase === "betting") {
        statusEl.textContent = hasActiveBet ? `puntata piazzata, partenza tra ${getStartCountdown()}s` : `puntate aperte, partenza tra ${getStartCountdown()}s`;
        startBtn.disabled = hasActiveBet || balance < 1;
        cashoutBtn.disabled = true;
        betInput.disabled = hasActiveBet;
        autoCashoutEnabled.disabled = hasActiveBet;
        autoCashoutInput.disabled = hasActiveBet;
        multiplierEl.classList.remove("running");
        return;
    }

    statusEl.textContent = hasCashedOut ? `uscito a ${lastCashout.toFixed(2)}x, attendi crash finale` : "round in corso";
    startBtn.disabled = true;
    cashoutBtn.disabled = !(hasActiveBet && !hasCashedOut);
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;
}

function estimateTimeForMultiplier(multiplier) {
    const safeMultiplier = Math.max(1, Number(multiplier) || 1);
    return Math.log(safeMultiplier) / Math.log(MULTIPLIER_GROWTH) * 0.05;
}


// ======== DISEGNO GRAFICO ========
function drawChart() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawAxes();
    drawTrail();
}

function drawGrid() {
    const bounds = getChartBounds();
    const scale = getChartScale();

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(127,143,166,0.12)";
    ctx.fillStyle = "rgba(127,143,166,0.72)";
    ctx.font = "11px system-ui, sans-serif";

    for (let i = 0; i <= 4; i++) {
        const x = bounds.left + (bounds.width / 4) * i;
        const timeLabel = Math.round((scale.maxTime / 4) * i);

        ctx.beginPath();
        ctx.moveTo(x, bounds.top);
        ctx.lineTo(x, bounds.bottom);
        ctx.stroke();
        ctx.fillText(timeLabel + "s", x - 8, canvas.height - 8);
    }

    for (let i = 0; i <= 4; i++) {
        const y = bounds.bottom - (bounds.height / 4) * i;
        const multiplierLabel = 1 + ((scale.maxMultiplier - 1) / 4) * i;

        ctx.beginPath();
        ctx.moveTo(bounds.left, y);
        ctx.lineTo(bounds.right, y);
        ctx.stroke();
        ctx.fillText(multiplierLabel.toFixed(2) + "x", 4, y + 4);
    }

    ctx.restore();
}

function drawAxes() {
    const bounds = getChartBounds();

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(127,143,166,0.36)";
    ctx.fillStyle = "rgba(229,237,245,0.7)";
    ctx.font = "12px system-ui, sans-serif";

    ctx.beginPath();
    ctx.moveTo(bounds.left, bounds.top);
    ctx.lineTo(bounds.left, bounds.bottom);
    ctx.lineTo(bounds.right, bounds.bottom);
    ctx.stroke();

    ctx.fillText("Moltiplicatore", bounds.left, 14);
    ctx.fillText("Tempo", bounds.right - 34, canvas.height - 8);
    ctx.restore();
}

function drawTrail() {

    if (trailPoints.length < 2) return;

    const bounds = getChartBounds();
    const scale = getChartScale();
    const scaledPoints = trailPoints.map(point => getPointForState(point.time, point.multiplier, scale));

    ctx.save();
    ctx.beginPath();
    ctx.rect(bounds.left, bounds.top, bounds.width, bounds.height);
    ctx.clip();
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Glow stile Aviator
    ctx.shadowColor = "rgba(255, 59, 48, 0.95)";
    ctx.shadowBlur = 22;

    ctx.beginPath();
    ctx.moveTo(scaledPoints[0].x, scaledPoints[0].y);

    // Dissolvenza progressiva
    for (let i = 1; i < scaledPoints.length - 1; i++) {
        const p = scaledPoints[i];
        const next = scaledPoints[i + 1];

        // alpha decrescente per scia "che svanisce"
        const alpha = i / scaledPoints.length;
        ctx.strokeStyle = `rgba(255, 79, 40, ${alpha})`;

        const cx = (p.x + next.x) / 2;
        const cy = (p.y + next.y) / 2;
        ctx.quadraticCurveTo(p.x, p.y, cx, cy);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx, cy);
    }

    ctx.restore();
}

function getChartBounds() {
    return {
        left: chartPadding.left,
        top: chartPadding.top,
        right: canvas.width - chartPadding.right,
        bottom: canvas.height - chartPadding.bottom,
        width: canvas.width - chartPadding.left - chartPadding.right,
        height: canvas.height - chartPadding.top - chartPadding.bottom
    };
}

function getChartScale() {
    const maxTime = Math.max(6, time + 1);
    const maxTrailMultiplier = trailPoints.reduce((max, point) => Math.max(max, point.multiplier), currentMultiplier);
    const maxMultiplier = Math.max(2, maxTrailMultiplier * 1.2);

    return { maxTime, maxMultiplier };
}

function getPointForState(pointTime, multiplier, scale = getChartScale()) {
    const bounds = getChartBounds();
    const normalizedTime = Math.min(pointTime / scale.maxTime, 1);
    const normalizedMultiplier = Math.min((multiplier - 1) / (scale.maxMultiplier - 1), 1);

    return {
        x: bounds.left + normalizedTime * bounds.width,
        y: bounds.bottom - normalizedMultiplier * bounds.height
    };
}


// ======== FURGONE SULLA PUNTA ========
function moveVan(x, y) {
    // sicurezza: non uscire dall'area
    if (x < 0) x = 0;
    if (x > canvas.width) x = canvas.width;
    if (y < 0) y = 0;
    if (y > canvas.height) y = canvas.height;

    // posiziona il container nel punto (x, y) del canvas
    vanContainer.style.left = x + "px";
    vanContainer.style.top = y + "px";
}

function resetVanPosition() {
    const startPoint = getPointForState(0, 1);
    vanContainer.style.left = startPoint.x + "px";
    vanContainer.style.top = startPoint.y + "px";
}




// ======== CRASH ========
function crash(crashPoint = revealedCrashPoint) {
    running = false;
    crashed = true;
    roundPhase = "crashed";
    clearInterval(intervalId);
    revealedCrashPoint = Number.isFinite(Number(crashPoint)) ? Number(crashPoint) : currentMultiplier;
    hasActiveBet = false;

    statusEl.textContent = "💥 CRASH!";
    startBtn.disabled = true;
    cashoutBtn.disabled = true;
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;
    autoCashoutThreshold = null;
    lastResultEl.textContent = "-" + formatCoins(currentBet) + " monete";
    addRoundHistory({
        id: createHistoryRecordId(),
        crashPoint: revealedCrashPoint,
        bet: currentBet,
        exitMultiplier: 0,
        netResult: -currentBet,
        timestamp: Date.now()
    });
    recordRoundResult(false, 0);
    updateWalletUI();
    updateAutoCashoutUI();
    window.aviatorAudio?.playCrash();
    triggerCrashFlash();

    multiplierEl.classList.remove("running", "cashed-out");
    multiplierEl.classList.add("crashed");
    vanContainer.classList.remove("flying");
    vanContainer.classList.add("crashed");
    vanImg.classList.remove("flying");
    vanImg.classList.add("crashed");
    startNextRoundCountdown();
}


// ======== AGGIORNAMENTO UI ========
function updateMultiplier() {
    multiplierEl.textContent = currentMultiplier.toFixed(2) + "x";
}

function cashout() {
    if (!hasActiveBet || hasCashedOut || crashed) return;

    running = false;
    clearInterval(intervalId);
    startBtn.disabled = true;
    cashoutBtn.disabled = true;
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;

    lastCashout = currentMultiplier;
    if (!bestCashout || lastCashout > bestCashout) {
        bestCashout = lastCashout;
        saveBestCashout();
    }

    const payout = currentBet * currentMultiplier;
    const netProfit = payout - currentBet;
    balance += payout;
    saveBalance();

    lastCashoutEl.textContent = lastCashout.toFixed(2) + "x";
    bestCashoutEl.textContent = bestCashout.toFixed(2) + "x";
    lastResultEl.textContent = "+" + formatCoins(payout) + " monete";
    const historyRecordId = createHistoryRecordId();
    addRoundHistory({
        id: historyRecordId,
        crashPoint: null,
        bet: currentBet,
        exitMultiplier: currentMultiplier,
        payout,
        netResult: netProfit,
        timestamp: Date.now()
    });
    pendingHistoryRecordId = historyRecordId;
    recordRoundResult(true, netProfit);
    autoCashoutThreshold = null;
    revealedCrashPoint = null;
    hasActiveBet = false;
    hasCashedOut = true;
    socket.emit("player_cashout", { multiplier: lastCashout });
    updateWalletUI();
    updateAutoCashoutUI();

    multiplierEl.classList.remove("running", "crashed");
    multiplierEl.classList.add("cashed-out");
    vanContainer.classList.remove("flying", "crashed");

    if (netProfit > 0) {
        window.aviatorAudio?.playCashout();
        showFloatingWin(netProfit);
        spawnCashoutParticles();
    }

    statusEl.textContent = `uscito a ${lastCashout.toFixed(2)}x, round ancora in corso`;
    vanImg.classList.remove("flying");

}

function showFloatingWin(amount) {
    if (!betPanelEl) return;

    const floatingWin = document.createElement("div");
    floatingWin.className = "floating-win";
    floatingWin.textContent = "+" + formatCoins(amount) + " monete";
    betPanelEl.appendChild(floatingWin);

    setTimeout(() => floatingWin.remove(), 1200);
}

function triggerCrashFlash() {
    if (!flightStageEl) return;

    flightStageEl.classList.remove("crash-flash");
    void flightStageEl.offsetWidth;
    flightStageEl.classList.add("crash-flash");

    setTimeout(() => flightStageEl.classList.remove("crash-flash"), 240);
}

function spawnCashoutParticles() {
    if (!flightStageEl) return;

    for (let i = 0; i < 14; i++) {
        const particle = document.createElement("div");
        const x = (Math.random() - 0.5) * 260;
        const y = -60 - Math.random() * 120;

        particle.className = "cashout-particle";
        particle.style.left = "50%";
        particle.style.top = "54%";
        particle.style.setProperty("--x", x + "px");
        particle.style.setProperty("--y", y + "px");
        particle.style.animationDelay = Math.random() * 0.12 + "s";

        flightStageEl.appendChild(particle);
        setTimeout(() => particle.remove(), 1000);
    }
}

function updateHistoryCrashPoint(recordId, crashPoint) {
    roundHistory = roundHistory.map(record => {
        if (record.id !== recordId) return record;
        return { ...record, crashPoint };
    });

    saveRoundHistory();
    renderRoundHistory();
}

function createHistoryRecordId() {
    return "round_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

function startNextRoundCountdown() {
    let remainingSeconds = 5;

    clearInterval(countdownId);
    countdownActive = true;
    startBtn.disabled = true;
    cashoutBtn.disabled = true;
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;
    statusEl.classList.add("countdown");
    statusEl.textContent = `Prossimo round in ${remainingSeconds}s`;

    countdownId = setInterval(() => {
        remainingSeconds -= 1;

        if (remainingSeconds <= 0) {
            finishNextRoundCountdown();
            return;
        }

        statusEl.textContent = `Prossimo round in ${remainingSeconds}s`;
    }, 1000);
}

function finishNextRoundCountdown() {
    clearInterval(countdownId);
    countdownId = null;
    countdownActive = false;
    statusEl.classList.remove("countdown");
    statusEl.textContent = "attendi apertura puntate";
    multiplierEl.classList.remove("running", "crashed", "cashed-out");
    vanContainer.classList.remove("flying", "crashed");
    betInput.disabled = true;
    autoCashoutEnabled.disabled = true;
    autoCashoutInput.disabled = true;
    cashoutBtn.disabled = true;
    updateAutoCashoutUI();
}

function initSessionUI() {
    if (currentUser) {
        hideWelcomeModal();
    } else {
        showWelcomeModal();
    }

    updateSessionHeader();
    saveLeaderboardEntry();
}

function loadUser() {
    try {
        const storedUser = JSON.parse(localStorage.getItem(USER_STORAGE_KEY));
        if (storedUser && typeof storedUser.nickname === "string" && storedUser.nickname.trim()) {
            return {
                nickname: storedUser.nickname.trim().slice(0, 16),
                createdAt: storedUser.createdAt || Date.now()
            };
        }
    } catch {
        return null;
    }

    return null;
}

function saveUser(user) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

function showWelcomeModal() {
    welcomeModal.hidden = false;
    document.body.classList.add("session-locked");
    setTimeout(() => nicknameInput.focus(), 0);
}

function hideWelcomeModal() {
    welcomeModal.hidden = true;
    document.body.classList.remove("session-locked");
}

function handleWelcomeSubmit(event) {
    event.preventDefault();

    const nickname = nicknameInput.value.trim().slice(0, 16);
    if (!nickname) return;

    currentUser = {
        nickname,
        createdAt: Date.now()
    };

    saveUser(currentUser);

    if (localStorage.getItem(BALANCE_STORAGE_KEY) === null) {
        balance = INITIAL_BALANCE;
        saveBalance();
    }

    hideWelcomeModal();
    updateWalletUI();
    saveLeaderboardEntry();
    if (socket.connected) socket.emit("player_join", { nickname: currentUser.nickname });
}

function updateSessionHeader() {
    headerNicknameEl.textContent = currentUser ? currentUser.nickname : "guest";
    headerBalanceEl.textContent = formatCoins(balance);
}

function toggleSettingsMenu() {
    settingsMenu.hidden = !settingsMenu.hidden;
}

function resetAccount() {
    if (!confirm("Vuoi davvero resettare l'account? Tutti i dati locali verranno cancellati.")) return;

    localStorage.clear();
    window.location.reload();
}

function loadStoredNumber(key) {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

function saveNumber(key, value) {
    localStorage.setItem(key, String(value));
}

function loadBestCashout() {
    const value = Number(localStorage.getItem(BEST_CASHOUT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
}

function saveBestCashout() {
    localStorage.setItem(BEST_CASHOUT_STORAGE_KEY, bestCashout.toFixed(2));
}

function recordRoundResult(won, netProfit) {
    gamesPlayed += 1;
    if (won) gamesWon += 1;
    if (netProfit > 0) totalWon += netProfit;

    saveNumber(GAMES_PLAYED_STORAGE_KEY, gamesPlayed);
    saveNumber(GAMES_WON_STORAGE_KEY, gamesWon);
    saveNumber(TOTAL_WON_STORAGE_KEY, totalWon.toFixed(2));
    saveLeaderboardEntry();
}

function saveLeaderboardEntry() {
    const entry = {
        nickname: currentUser ? currentUser.nickname : "guest",
        bestCashout: bestCashout || 0,
        totalWon,
        gamesPlayed
    };

    localStorage.setItem(LEADERBOARD_ENTRY_STORAGE_KEY, JSON.stringify(entry));
}

function loadBalance() {
    const storedBalance = Number(localStorage.getItem(BALANCE_STORAGE_KEY));
    return Number.isFinite(storedBalance) && storedBalance >= 0 ? storedBalance : INITIAL_BALANCE;
}

function saveBalance() {
    localStorage.setItem(BALANCE_STORAGE_KEY, balance.toFixed(2));
}

function loadRoundHistory() {
    try {
        const storedHistory = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY));
        return Array.isArray(storedHistory) ? storedHistory.slice(0, MAX_HISTORY_ITEMS) : [];
    } catch {
        return [];
    }
}

function saveRoundHistory() {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(roundHistory));
}

function addRoundHistory(record) {
    roundHistory.unshift({ id: record.id || createHistoryRecordId(), ...record });
    roundHistory = roundHistory.slice(0, MAX_HISTORY_ITEMS);
    saveRoundHistory();
    renderRoundHistory();
}

function renderRoundHistory() {
    if (!roundHistory.length) {
        historyListEl.innerHTML = '<p class="history-empty">Nessun round giocato.</p>';
        return;
    }

    historyListEl.innerHTML = roundHistory.slice(0, MAX_VISIBLE_HISTORY_ITEMS).map(record => {
        const isProfit = record.netResult > 0;
        const payout = getHistoryPayout(record);
        const resultPrefix = payout > 0 ? "+" : "";
        const exitText = record.exitMultiplier > 0 ? record.exitMultiplier.toFixed(2) + "x" : "0.00x";
        const hasCrashPoint = record.crashPoint !== null && record.crashPoint !== undefined && Number.isFinite(Number(record.crashPoint));
        const crashText = hasCrashPoint ? Number(record.crashPoint).toFixed(2) + "x" : "in corso";
        const crashClass = getCrashClass(record.crashPoint);
        const dateText = new Date(record.timestamp).toLocaleString("it-IT", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });

        return `
            <div class="history-item ${isProfit ? "profit" : "loss"}">
                <span>${dateText}</span>
                <span class="crash-pill ${crashClass}">${crashText}</span>
                <span>Puntata ${formatCoins(record.bet)}</span>
                <span>Uscita ${exitText}</span>
                <strong>${resultPrefix}${formatCoins(payout)}</strong>
            </div>
        `;
    }).join("");
}

function getHistoryPayout(record) {
    const storedPayout = Number(record.payout);

    if (Number.isFinite(storedPayout)) return storedPayout;
    if (record.netResult > 0) return Number(record.bet) + Number(record.netResult);
    return Number(record.netResult) || 0;
}

function renderGlobalHistory(animateFirst = false) {
    if (!globalHistoryListEl) return;

    if (!globalHistory.length) {
        globalHistoryListEl.innerHTML = '<span class="global-history-empty">nessun crash ancora</span>';
        return;
    }

    globalHistoryListEl.innerHTML = globalHistory.map((round, index) => {
        const crashPoint = Number(round.crash_point);
        const crashClass = getCrashClass(crashPoint);
        const animateClass = animateFirst && index === 0 ? "new" : "";

        return `<span class="global-crash-pill ${crashClass} ${animateClass}">${crashPoint.toFixed(2)}x</span>`;
    }).join("");
}

function renderPlayersPanel(players) {
    if (!playersListEl || !playersCountEl) return;

    const sortedPlayers = [...players].sort((a, b) => {
        const stateDiff = getPlayerSortWeight(a.state) - getPlayerSortWeight(b.state);
        if (stateDiff !== 0) return stateDiff;
        return String(a.nickname || "").localeCompare(String(b.nickname || ""), "it");
    });

    playersCountEl.textContent = String(sortedPlayers.length);

    if (!sortedPlayers.length) {
        playersListEl.innerHTML = '<p class="players-empty">nessun giocatore connesso</p>';
        previousPlayerStates = new Map();
        return;
    }

    const nextPlayerStates = new Map();
    playersListEl.innerHTML = sortedPlayers.map((player, index) => {
        const nickname = String(player.nickname || "Ospite");
        const safeNickname = escapeHtml(nickname);
        const state = ["betting", "cashedout", "watching"].includes(player.state) ? player.state : "watching";
        const bet = Number(player.bet) || 0;
        const exitMultiplier = Number(player.exit_multiplier);
        const key = `${nickname}:${index}`;
        const stateSignature = `${state}:${bet}:${Number.isFinite(exitMultiplier) ? exitMultiplier.toFixed(2) : ""}`;
        const changed = previousPlayerStates.has(key) && previousPlayerStates.get(key) !== stateSignature;
        const detail = getPlayerDetail(state, bet, exitMultiplier);

        nextPlayerStates.set(key, stateSignature);

        return `
            <div class="player-row ${state} ${changed ? "changed" : ""}">
                <span class="player-avatar" style="--avatar-color: ${getPlayerAvatarColor(nickname)}">${getPlayerInitial(nickname)}</span>
                <span class="player-main">
                    <strong>${safeNickname}</strong>
                    ${detail}
                </span>
            </div>
        `;
    }).join("");

    previousPlayerStates = nextPlayerStates;
}

function getPlayerDetail(state, bet, exitMultiplier) {
    if (state === "cashedout") {
        const exitText = Number.isFinite(exitMultiplier) ? `${exitMultiplier.toFixed(2)}x ✓` : "cashout ✓";
        const betText = bet > 0 ? `<span>${formatCoins(bet)} monete</span>` : "";
        return `<span class="player-detail">${betText}<em class="player-exit">${exitText}</em></span>`;
    }

    if (state === "betting" && bet > 0) {
        return `<span class="player-detail"><span>${formatCoins(bet)} monete</span></span>`;
    }

    return '<span class="player-detail muted">in osservazione</span>';
}

function getPlayerSortWeight(state) {
    if (state === "betting") return 0;
    if (state === "cashedout") return 1;
    return 2;
}

function getPlayerInitial(nickname) {
    return escapeHtml(String(nickname || "O").trim().charAt(0).toUpperCase() || "O");
}

function getPlayerAvatarColor(nickname) {
    const colors = ["#f97316", "#22c55e", "#38bdf8", "#c084fc", "#f43f5e", "#eab308"];
    const text = String(nickname || "Ospite");
    let hash = 0;

    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }

    return colors[hash % colors.length];
}

function getCurrentNickname() {
    return currentUser?.nickname || "Ospite";
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;"
    }[char]));
}

function getCrashClass(crashPoint) {
    const value = Number(crashPoint);

    if (!Number.isFinite(value)) return "unknown";
    if (value < 1.4) return "very-low";
    if (value <= 2) return "low";
    if (value <= 5) return "mid";
    return "high";
}

function getValidatedBet() {
    const bet = Number(betInput.value);

    if (!Number.isFinite(bet) || bet < 1) {
        statusEl.textContent = "Inserisci una puntata valida.";
        return null;
    }

    if (bet > balance) {
        statusEl.textContent = "Saldo insufficiente per questa puntata.";
        return null;
    }

    return bet;
}

function getAutoCashoutValue() {
    const value = Number(autoCashoutInput.value);

    if (!Number.isFinite(value) || value < MIN_AUTO_CASHOUT) {
        statusEl.textContent = "La soglia auto cashout deve essere almeno 1.01x.";
        return null;
    }

    return value;
}

function updateWalletUI() {
    balanceEl.textContent = formatCoins(balance);
    headerBalanceEl.textContent = formatCoins(balance);
    updateSessionHeader();
    if (bestCashout) bestCashoutEl.textContent = bestCashout.toFixed(2) + "x";
    startBtn.disabled = running || countdownActive || balance < 1 || (roundPhase !== null && roundPhase !== "betting");
    updateBetInputLimits();
}

function updateBetInputLimits() {
    betInput.max = balance.toFixed(2);

    if (!running && balance > 0 && Number(betInput.value) > balance) {
        betInput.value = Math.max(1, Math.floor(balance));
    }
}

function updateAutoCashoutUI() {
    const enabled = autoCashoutEnabled.checked;
    const thresholdText = Number(autoCashoutInput.value).toFixed(2);

    autoCashoutStatus.classList.toggle("active", running && enabled && Boolean(autoCashoutThreshold));

    if (running && autoCashoutThreshold) {
        autoCashoutStatus.textContent = `Auto cashout attivo a ${autoCashoutThreshold.toFixed(2)}x`;
        return;
    }

    if (enabled) {
        autoCashoutStatus.textContent = `Auto cashout pronto a ${thresholdText}x`;
        return;
    }

    autoCashoutStatus.textContent = "Auto cashout disattivato";
}

function formatCoins(value) {
    return Number(value).toFixed(2);
}
