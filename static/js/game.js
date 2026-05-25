// ======== VARIABILI GIOCO ========
let running = false;
let crashed = false;
let currentMultiplier = 1.0;
let intervalId = null;
let countdownId = null;
let countdownActive = false;

let lastCashout = null;
let bestCashout = null;

const INITIAL_BALANCE = 1000;
const BALANCE_STORAGE_KEY = "aviator_balance";
const HISTORY_STORAGE_KEY = "aviator_round_history";
const MAX_HISTORY_ITEMS = 10;
const MIN_AUTO_CASHOUT = 1.01;

let balance = loadBalance();
let currentBet = 0;
let roundHistory = loadRoundHistory();
let autoCashoutThreshold = null;
let currentRoundId = null;
let revealedCrashPoint = null;
let serverCheckInProgress = false;

const multiplierEl = document.getElementById("multiplier-value");
const statusEl = document.getElementById("status-text");
const startBtn = document.getElementById("start-btn");
const cashoutBtn = document.getElementById("cashout-btn");
const balanceEl = document.getElementById("balance-value");
const betInput = document.getElementById("bet-input");
const autoCashoutEnabled = document.getElementById("auto-cashout-enabled");
const autoCashoutInput = document.getElementById("auto-cashout-input");
const autoCashoutStatus = document.getElementById("auto-cashout-status");
const currentBetEl = document.getElementById("current-bet");
const lastResultEl = document.getElementById("last-result");
const historyListEl = document.getElementById("history-list");
const lastCashoutEl = document.getElementById("last-cashout");
const bestCashoutEl = document.getElementById("best-cashout");
const vanContainer = document.getElementById("van");
const vanImg = document.getElementById("van-img");

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

function startRound() {
    if (running || countdownActive) return;

    const bet = getValidatedBet();
    if (!bet) return;

    const requestedAutoCashout = autoCashoutEnabled.checked ? getAutoCashoutValue() : null;
    if (autoCashoutEnabled.checked && !requestedAutoCashout) return;

    fetch("/api/round", { method: "POST" })
        .then(res => res.json())
        .then(data => {
            currentRoundId = data.round_id;
            revealedCrashPoint = null;
            currentBet = bet;
            autoCashoutThreshold = requestedAutoCashout;
            balance -= currentBet;
            saveBalance();
            resetRound();

            running = true;
            crashed = false;

            statusEl.textContent = "Il furgone parte!";
            startBtn.disabled = true;
            cashoutBtn.disabled = false;
            betInput.disabled = true;
            autoCashoutEnabled.disabled = true;
            autoCashoutInput.disabled = true;
            currentBetEl.textContent = formatCoins(currentBet) + " monete";
            lastResultEl.textContent = "-";
            updateWalletUI();
            updateAutoCashoutUI();

            vanImg.classList.remove("crashed");
            vanImg.classList.add("flying");


            intervalId = setInterval(gameTick, 50);
        });
}

function resetRound() {
    currentMultiplier = 1.0;
    time = 0;
    trailPoints = [];
    drawChart();
    resetVanPosition();
    updateMultiplier();
}


// ======== TICK PRINCIPALE ========
async function gameTick() {
    if (!running) return;
    if (serverCheckInProgress) return;

    // crescita del moltiplicatore
    currentMultiplier += 0.012 * currentMultiplier;

    if (await checkServerCrash()) {
        return;
    }

    if (autoCashoutThreshold && currentMultiplier >= autoCashoutThreshold) {
        cashout();
        return;
    }

    updateMultiplier();

    time += 0.05;

    const { x, y } = getPointForState(time, currentMultiplier);

    trailPoints.push({ time, multiplier: currentMultiplier, x, y });

    drawChart();
    moveVan(x, y);
}

async function checkServerCrash() {
    if (!currentRoundId || serverCheckInProgress) return false;

    serverCheckInProgress = true;

    try {
        const response = await fetch("/api/check", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                round_id: currentRoundId,
                current_multiplier: currentMultiplier
            })
        });

        const data = await response.json();

        if (!running) return true;

        if (data.crashed) {
            revealedCrashPoint = Number.isFinite(Number(data.crash_point)) ? Number(data.crash_point) : currentMultiplier;
            crash();
            return true;
        }
    } catch {
        statusEl.textContent = "Errore di connessione al server.";
    } finally {
        serverCheckInProgress = false;
    }

    return false;
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
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
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
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
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
    ctx.shadowColor = "rgba(255, 170, 0, 1)";
    ctx.shadowBlur = 18;

    ctx.beginPath();
    ctx.moveTo(scaledPoints[0].x, scaledPoints[0].y);

    // Dissolvenza progressiva
    for (let i = 1; i < scaledPoints.length - 1; i++) {
        const p = scaledPoints[i];
        const next = scaledPoints[i + 1];

        // alpha decrescente per scia "che svanisce"
        const alpha = i / scaledPoints.length;
        ctx.strokeStyle = `rgba(255, 150, 0, ${alpha})`;

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
function crash() {
    running = false;
    crashed = true;
    clearInterval(intervalId);

    statusEl.textContent = "💥 CRASH!";
    startBtn.disabled = false;
    cashoutBtn.disabled = true;
    betInput.disabled = false;
    autoCashoutEnabled.disabled = false;
    autoCashoutInput.disabled = false;
    autoCashoutThreshold = null;
    lastResultEl.textContent = "-" + formatCoins(currentBet) + " monete";
    addRoundHistory({
        crashPoint: revealedCrashPoint,
        bet: currentBet,
        exitMultiplier: 0,
        netResult: -currentBet,
        timestamp: Date.now()
    });
    currentRoundId = null;
    updateWalletUI();
    updateAutoCashoutUI();

    vanImg.classList.remove("flying");
    vanImg.classList.add("crashed");
    startNextRoundCountdown();
}


// ======== AGGIORNAMENTO UI ========
function updateMultiplier() {
    multiplierEl.textContent = currentMultiplier.toFixed(2) + "x";
}

function cashout() {
    if (!running || crashed) return;

    running = false;
    clearInterval(intervalId);
    startBtn.disabled = false;
    cashoutBtn.disabled = true;
    betInput.disabled = false;
    autoCashoutEnabled.disabled = false;
    autoCashoutInput.disabled = false;

    lastCashout = currentMultiplier;
    if (!bestCashout || lastCashout > bestCashout) bestCashout = lastCashout;

    const payout = currentBet * currentMultiplier;
    balance += payout;
    saveBalance();

    lastCashoutEl.textContent = lastCashout.toFixed(2) + "x";
    bestCashoutEl.textContent = bestCashout.toFixed(2) + "x";
    lastResultEl.textContent = "+" + formatCoins(payout) + " monete";
    addRoundHistory({
        crashPoint: null,
        bet: currentBet,
        exitMultiplier: currentMultiplier,
        netResult: payout - currentBet,
        timestamp: Date.now()
    });
    autoCashoutThreshold = null;
    currentRoundId = null;
    revealedCrashPoint = null;
    updateWalletUI();
    updateAutoCashoutUI();

    statusEl.textContent = `Uscito a ${lastCashout.toFixed(2)}x!`;
    vanImg.classList.remove("flying");
    startNextRoundCountdown();

}

function startNextRoundCountdown() {
    let remainingSeconds = 3;

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
    statusEl.textContent = 'Premi "Nuovo round" per iniziare';
    betInput.disabled = false;
    autoCashoutEnabled.disabled = false;
    autoCashoutInput.disabled = false;
    cashoutBtn.disabled = true;
    updateWalletUI();
    updateAutoCashoutUI();
}

function loadBalance() {
    const storedBalance = Number(localStorage.getItem(BALANCE_STORAGE_KEY));
    return Number.isFinite(storedBalance) && storedBalance >= 1 ? storedBalance : INITIAL_BALANCE;
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
    roundHistory.unshift(record);
    roundHistory = roundHistory.slice(0, MAX_HISTORY_ITEMS);
    saveRoundHistory();
    renderRoundHistory();
}

function renderRoundHistory() {
    if (!roundHistory.length) {
        historyListEl.innerHTML = '<p class="history-empty">Nessun round giocato.</p>';
        return;
    }

    historyListEl.innerHTML = roundHistory.map(record => {
        const isProfit = record.netResult > 0;
        const resultPrefix = record.netResult > 0 ? "+" : "";
        const exitText = record.exitMultiplier > 0 ? record.exitMultiplier.toFixed(2) + "x" : "0.00x";
        const hasCrashPoint = record.crashPoint !== null && record.crashPoint !== undefined && Number.isFinite(Number(record.crashPoint));
        const crashText = hasCrashPoint ? Number(record.crashPoint).toFixed(2) + "x" : "non rivelato";
        const dateText = new Date(record.timestamp).toLocaleString("it-IT", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });

        return `
            <div class="history-item ${isProfit ? "profit" : "loss"}">
                <span>${dateText}</span>
                <span>Crash ${crashText}</span>
                <span>Puntata ${formatCoins(record.bet)}</span>
                <span>Uscita ${exitText}</span>
                <strong>${resultPrefix}${formatCoins(record.netResult)}</strong>
            </div>
        `;
    }).join("");
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
    startBtn.disabled = running || countdownActive || balance < 1;
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
