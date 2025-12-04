// ======== VARIABILI GIOCO ========
let running = false;
let crashed = false;
let currentMultiplier = 1.0;
let crashPoint = 2.0;
let intervalId = null;

let lastCashout = null;
let bestCashout = null;

const multiplierEl = document.getElementById("multiplier-value");
const statusEl = document.getElementById("status-text");
const startBtn = document.getElementById("start-btn");
const cashoutBtn = document.getElementById("cashout-btn");
const lastCashoutEl = document.getElementById("last-cashout");
const bestCashoutEl = document.getElementById("best-cashout");
const vanContainer = document.getElementById("van");
const vanImg = document.getElementById("van-img");


// ======== CANVAS SCIA ========
const canvas = document.getElementById("trail-canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

let trailPoints = [];
let time = 0;


// ======== ROUND ========
startBtn.addEventListener("click", startRound);
cashoutBtn.addEventListener("click", cashout);

function startRound() {
    if (running) return;

    fetch("/api/round")
        .then(res => res.json())
        .then(data => {
            crashPoint = data.crash_point;
            resetRound();

            running = true;
            crashed = false;

            statusEl.textContent = `Il furgone parte! Crash a circa ${crashPoint}x`;
            startBtn.disabled = true;
            cashoutBtn.disabled = false;

            vanImg.classList.remove("crashed");
            vanImg.classList.add("flying");


            intervalId = setInterval(gameTick, 50);
        });
}

function resetRound() {
    currentMultiplier = 1.0;
    time = 0;
    trailPoints = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    updateMultiplier();
}


// ======== TICK PRINCIPALE ========
function gameTick() {
    if (!running) return;

    // crescita del moltiplicatore
    currentMultiplier += 0.012 * currentMultiplier;

    if (currentMultiplier >= crashPoint) {
        crash();
        return;
    }

    updateMultiplier();

    time += 0.05;

    // ----- CURVA IDENTICA AD AVIATOR -----
    const x = 40 + time * 50; 
    const y = canvas.height - Math.pow(currentMultiplier, 1.35) * 10;

    trailPoints.push({ x, y });

    drawTrail();
    moveVan(x, y);
}


// ======== DISEGNO SCIA PROFESSIONALE ========
function drawTrail() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (trailPoints.length < 2) return;

    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Glow stile Aviator
    ctx.shadowColor = "rgba(255, 170, 0, 1)";
    ctx.shadowBlur = 18;

    ctx.beginPath();
    ctx.moveTo(trailPoints[0].x, trailPoints[0].y);

    // Dissolvenza progressiva
    for (let i = 1; i < trailPoints.length - 1; i++) {
        const p = trailPoints[i];
        const next = trailPoints[i + 1];

        // alpha decrescente per scia "che svanisce"
        const alpha = i / trailPoints.length;
        ctx.strokeStyle = `rgba(255, 150, 0, ${alpha})`;

        const cx = (p.x + next.x) / 2;
        const cy = (p.y + next.y) / 2;
        ctx.quadraticCurveTo(p.x, p.y, cx, cy);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx, cy);
    }
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




// ======== CRASH ========
function crash() {
    running = false;
    crashed = true;
    clearInterval(intervalId);

    statusEl.textContent = "💥 CRASH!";
    startBtn.disabled = false;
    cashoutBtn.disabled = true;

    vanImg.classList.remove("flying");
    vanImg.classList.add("crashed");
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

    lastCashout = currentMultiplier;
    if (!bestCashout || lastCashout > bestCashout) bestCashout = lastCashout;

    lastCashoutEl.textContent = lastCashout.toFixed(2) + "x";
    bestCashoutEl.textContent = bestCashout.toFixed(2) + "x";

    statusEl.textContent = `Uscito a ${lastCashout.toFixed(2)}x!`;
    vanImg.classList.remove("flying");

}
