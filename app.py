from flask import Flask, flash, jsonify, redirect, render_template, request, send_from_directory, url_for
from flask_login import LoginManager, UserMixin, current_user, login_required, login_user, logout_user
from flask_socketio import SocketIO, emit
from mutagen.mp3 import MP3
from werkzeug.security import check_password_hash, generate_password_hash
from db import create_user, get_balance, get_user_by_id, get_user_by_username, init_db, update_balance
import os
import random
import threading
import time
import uuid

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key-cambiami")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
login_manager = LoginManager()
login_manager.login_view = "login"
login_manager.init_app(app)
init_db()

current_round = None
round_history = []
connected_players = {}
active_bets = {}
queued_bets = {}
radio_state = {
    "playlist": [],
    "current_index": 0,
    "started_at": 0.0
}
radio_durations = {}
players_lock = threading.Lock()
active_bets_lock = threading.Lock()
queued_bets_lock = threading.Lock()
radio_lock = threading.Lock()
TICK_SECONDS = 0.05
MULTIPLIER_GROWTH = 1.012
BETTING_SECONDS = 5
POST_CRASH_SECONDS = 5
MAX_ROUND_HISTORY = 20
RADIO_DIR = "radio"
RADIO_FALLBACK_DURATION = 240


class User(UserMixin):
    def __init__(self, id, username, balance):
        self.id = str(id)
        self.username = username
        self.balance = float(balance)


@login_manager.user_loader
def load_user(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return None

    return User(user["id"], user["username"], user["balance"])


def init_radio():
    playlist = []
    durations = {}

    if os.path.isdir(RADIO_DIR):
        playlist = [
            filename
            for filename in os.listdir(RADIO_DIR)
            if filename.lower().endswith(".mp3") and os.path.isfile(os.path.join(RADIO_DIR, filename))
        ]

    random.shuffle(playlist)

    for filename in playlist:
        path = os.path.join(RADIO_DIR, filename)
        try:
            durations[filename] = float(MP3(path).info.length)
        except Exception:
            # Se la durata non è leggibile, usiamo una stima sicura per continuare la radio.
            durations[filename] = RADIO_FALLBACK_DURATION

    with radio_lock:
        radio_state["playlist"] = playlist
        radio_state["current_index"] = 0
        radio_state["started_at"] = time.time() if playlist else 0.0
        radio_durations.clear()
        radio_durations.update(durations)


def get_radio_payload():
    with radio_lock:
        playlist = radio_state["playlist"]
        if not playlist:
            return {
                "filename": None,
                "started_at": 0.0,
                "server_time": time.time(),
                "index": 0,
                "total": 0,
                "duration": 0
            }

        current_index = radio_state["current_index"]
        filename = playlist[current_index]
        return {
            "filename": filename,
            "started_at": radio_state["started_at"],
            "server_time": time.time(),
            "index": current_index,
            "total": len(playlist),
            "duration": radio_durations.get(filename, RADIO_FALLBACK_DURATION)
        }


def advance_radio_track():
    with radio_lock:
        if not radio_state["playlist"]:
            return None

        next_index = radio_state["current_index"] + 1

        if next_index >= len(radio_state["playlist"]):
            # A fine giro rimescoliamo la playlist per non ripetere sempre lo stesso ordine.
            random.shuffle(radio_state["playlist"])
            next_index = 0

        radio_state["current_index"] = next_index
        radio_state["started_at"] = time.time()

    return get_radio_payload()


init_radio()


def generate_crash_point():
    """
    Genera il punto di crash (tipo Aviator).
    Più il numero è alto, più il furgone vola a lungo.
    Qui limitiamo a max 100x, giusto per demo.
    """
    r = random.random()
    crash = 1 / (1 - r)
    crash = min(crash, 100)
    return round(crash, 2)


def create_round():
    created_at = time.time()

    return {
        "round_id": str(uuid.uuid4()),
        "crash_point": generate_crash_point(),
        "started_at": created_at + BETTING_SECONDS,
        "bets_locked": False,
        "active": True,
        "crashed_at": None
    }


def get_server_multiplier(started_at):
    if time.time() < started_at:
        return 1.0

    elapsed = max(0, time.time() - started_at)
    ticks = elapsed / TICK_SECONDS
    return round(MULTIPLIER_GROWTH ** ticks, 2)


def get_round_state_payload():
    if not current_round:
        return None

    active = current_round["active"]
    payload = {
        "round_id": current_round["round_id"],
        "started_at": current_round["started_at"],
        "multiplier_now": get_server_multiplier(current_round["started_at"]),
        "active": active,
        "round_history": round_history,
        "players": get_players_payload(),
        "server_time": time.time()
    }

    if not active:
        payload["crash_point"] = current_round["crash_point"]

    return payload


def emit_round_start():
    reset_connected_players_for_round()
    socketio.emit("round_start", {
        "round_id": current_round["round_id"],
        "started_at": current_round["started_at"],
        "server_time": time.time()
    })
    emit_players_update()


def promote_queued_bets(round_id):
    # Le puntate preparate diventano puntate reali solo al decollo del round.
    with queued_bets_lock:
        queued_items = list(queued_bets.items())
        queued_bets.clear()

    if not queued_items:
        return

    with active_bets_lock:
        for user_id, bet in queued_items:
            active_bets[user_id] = {
                "amount": bet["amount"],
                "round_id": round_id
            }

    with players_lock:
        for user_id, bet in queued_items:
            for sid, player in connected_players.items():
                if player.get("user_id") == user_id:
                    player["bet"] = bet["amount"]
                    player["state"] = "betting"
                    player["exit_multiplier"] = None
                    socketio.emit("bet_activated", {
                        "round_id": round_id,
                        "amount": bet["amount"]
                    }, to=sid)


def get_players_payload():
    # Il lock evita letture parziali mentre il thread del gioco resetta i giocatori.
    with players_lock:
        return [
            {
                "nickname": player["nickname"],
                "bet": player.get("bet", 0),
                "state": player.get("state", "watching"),
                "exit_multiplier": player.get("exit_multiplier")
            }
            for player in connected_players.values()
        ]


def emit_players_update():
    socketio.emit("players_update", {"players": get_players_payload()})


def reset_connected_players_for_round():
    # A ogni nuovo round tutti tornano spettatori finché non piazzano una puntata.
    with players_lock:
        for player in connected_players.values():
            player["bet"] = 0
            player["state"] = "watching"
            player["exit_multiplier"] = None


def normalize_nickname(value):
    nickname = str(value or "").strip()[:16]
    return nickname or "Ospite"


def get_positive_float(value):
    try:
        return max(0, float(value or 0))
    except (TypeError, ValueError):
        return 0


def is_betting_window_open():
    return current_round and current_round["active"] and time.time() < current_round["started_at"]


def update_connected_player_bet(user_id, amount):
    with players_lock:
        for player in connected_players.values():
            if player.get("user_id") == user_id:
                player["bet"] = amount
                player["state"] = "betting"
                player["exit_multiplier"] = None

    emit_players_update()


def update_connected_player_cashout(user_id, multiplier):
    with players_lock:
        for player in connected_players.values():
            if player.get("user_id") == user_id:
                player["state"] = "cashedout"
                player["exit_multiplier"] = round(multiplier, 2)

    emit_players_update()


def clear_active_bets_for_round(round_id):
    # Le puntate sono già state scalate quando vengono piazzate; al crash vanno solo chiuse.
    with active_bets_lock:
        crashed_user_ids = [
            user_id
            for user_id, bet in active_bets.items()
            if bet.get("round_id") == round_id
        ]

        for user_id in crashed_user_ids:
            active_bets.pop(user_id, None)


def add_round_history(round_data):
    round_history.insert(0, {
        "round_id": round_data["round_id"],
        "crash_point": round_data["crash_point"],
        "crashed_at": round_data["crashed_at"]
    })
    del round_history[MAX_ROUND_HISTORY:]


def game_loop():
    global current_round

    current_round = create_round()
    emit_round_start()

    while True:
        time.sleep(TICK_SECONDS)

        if not current_round:
            current_round = create_round()
            emit_round_start()
            continue

        if not current_round["active"]:
            time.sleep(POST_CRASH_SECONDS)
            current_round = create_round()
            emit_round_start()
            continue

        if not current_round.get("bets_locked") and time.time() >= current_round["started_at"]:
            current_round["bets_locked"] = True
            promote_queued_bets(current_round["round_id"])
            emit_players_update()

        multiplier = get_server_multiplier(current_round["started_at"])

        if multiplier >= current_round["crash_point"]:
            current_round["active"] = False
            current_round["crashed_at"] = time.time()
            add_round_history(current_round)
            clear_active_bets_for_round(current_round["round_id"])
            socketio.emit("crash", {
                "round_id": current_round["round_id"],
                "crash_point": current_round["crash_point"],
                "round_history": round_history,
                "server_time": time.time()
            })
            continue

        socketio.emit("tick", {
            "round_id": current_round["round_id"],
            "multiplier": multiplier,
            "server_time": time.time()
        })


def radio_loop():
    while True:
        time.sleep(1)

        payload = get_radio_payload()
        if not payload["filename"]:
            continue

        if time.time() - payload["started_at"] >= payload["duration"]:
            next_payload = advance_radio_track()
            if next_payload:
                socketio.emit("radio_update", next_payload)


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/radio/<path:filename>")
def serve_radio(filename):
    return send_from_directory(RADIO_DIR, filename)


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = get_user_by_username(username)

        if user and check_password_hash(user["password_hash"], password):
            login_user(User(user["id"], user["username"], user["balance"]))
            return redirect(url_for("index"))

        flash("Username o password non validi.")

    return render_template("login.html")


@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()[:16]
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        if not username or not password:
            flash("Inserisci username e password.")
            return render_template("register.html")

        if password != confirm_password:
            flash("Le password non coincidono.")
            return render_template("register.html")

        if get_user_by_username(username):
            flash("Username già esistente.")
            return render_template("register.html")

        create_user(username, generate_password_hash(password))
        return redirect(url_for("login"))

    return render_template("register.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))


@app.route("/api/balance")
@login_required
def api_balance():
    balance = get_balance(current_user.id)
    with queued_bets_lock:
        queued_bet = queued_bets.get(int(current_user.id))

    return jsonify({
        "balance": balance,
        "username": current_user.username,
        "queued_bet": queued_bet["amount"] if queued_bet else 0
    })


@app.route("/api/bet", methods=["POST"])
@login_required
def api_bet():
    amount = get_positive_float((request.get_json(silent=True) or {}).get("amount"))
    if amount <= 0:
        return jsonify({"ok": False, "error": "Puntata non valida"}), 400

    if not current_round:
        return jsonify({"ok": False, "error": "Round non disponibile"}), 400

    user_id = int(current_user.id)
    balance = get_balance(user_id)
    if balance < amount:
        return jsonify({"ok": False, "error": "Saldo insufficiente"}), 400

    with queued_bets_lock:
        if user_id in queued_bets:
            return jsonify({"ok": False, "error": "Hai già una puntata preparata"}), 400

    with active_bets_lock:
        active_bet = active_bets.get(user_id)
        if active_bet and active_bet.get("round_id") == current_round["round_id"]:
            return jsonify({"ok": False, "error": "Puntata già attiva"}), 400

    new_balance = balance - amount
    update_balance(user_id, new_balance)
    with queued_bets_lock:
        queued_bets[user_id] = {"amount": amount}

    return jsonify({"ok": True, "balance": new_balance, "mode": "queued"})


@app.route("/api/bet/cancel", methods=["POST"])
@login_required
def api_cancel_bet():
    user_id = int(current_user.id)

    with queued_bets_lock:
        queued_bet = queued_bets.pop(user_id, None)

    if not queued_bet:
        return jsonify({"ok": False, "error": "Nessuna puntata preparata"}), 400

    new_balance = get_balance(user_id) + queued_bet["amount"]
    update_balance(user_id, new_balance)
    return jsonify({"ok": True, "balance": new_balance})


@app.route("/api/cashout", methods=["POST"])
@login_required
def api_cashout():
    multiplier = get_positive_float((request.get_json(silent=True) or {}).get("multiplier"))
    if multiplier <= 0:
        return jsonify({"ok": False, "error": "Moltiplicatore non valido"}), 400

    user_id = int(current_user.id)
    with active_bets_lock:
        active_bet = active_bets.get(user_id)
        if not current_round or not active_bet or active_bet.get("round_id") != current_round["round_id"]:
            return jsonify({"ok": False, "error": "Nessuna puntata attiva"}), 400

        amount = active_bet["amount"]
        active_bets.pop(user_id, None)

    won = amount * multiplier
    new_balance = get_balance(user_id) + won
    update_balance(user_id, new_balance)
    update_connected_player_cashout(user_id, multiplier)
    return jsonify({"ok": True, "balance": new_balance, "won": won})


@app.route("/api/radio/skip", methods=["POST"])
@login_required
def api_radio_skip():
    payload = advance_radio_track()
    if not payload:
        return jsonify({"ok": False, "error": "Nessun brano disponibile"}), 404

    socketio.emit("radio_update", payload)
    return jsonify({"ok": True, "radio": payload})


@socketio.on("join")
def handle_join():
    global current_round

    if not current_round:
        current_round = create_round()
        emit_round_start()

    emit("round_state", get_round_state_payload())
    emit("radio_state", get_radio_payload())


@socketio.on("radio_request_state")
def handle_radio_request_state():
    emit("radio_state", get_radio_payload())


@socketio.on("player_join")
def handle_player_join(data):
    nickname = current_user.username if current_user.is_authenticated else normalize_nickname((data or {}).get("nickname"))
    user_id = int(current_user.id) if current_user.is_authenticated else None

    with players_lock:
        existing = connected_players.get(request.sid, {})
        connected_players[request.sid] = {
            "nickname": nickname,
            "user_id": user_id,
            "bet": existing.get("bet", 0),
            "state": existing.get("state", "watching"),
            "exit_multiplier": existing.get("exit_multiplier")
        }

    emit_players_update()


@socketio.on("player_bet")
def handle_player_bet(data):
    bet = get_positive_float((data or {}).get("bet"))

    with players_lock:
        player = connected_players.setdefault(request.sid, {
            "nickname": current_user.username if current_user.is_authenticated else "Ospite",
            "user_id": int(current_user.id) if current_user.is_authenticated else None,
            "bet": 0,
            "state": "watching",
            "exit_multiplier": None
        })
        player["bet"] = bet
        player["state"] = "betting"
        player["exit_multiplier"] = None

    emit_players_update()


@socketio.on("player_cashout")
def handle_player_cashout(data):
    multiplier = get_positive_float((data or {}).get("multiplier"))

    with players_lock:
        player = connected_players.setdefault(request.sid, {
            "nickname": current_user.username if current_user.is_authenticated else "Ospite",
            "user_id": int(current_user.id) if current_user.is_authenticated else None,
            "bet": 0,
            "state": "watching",
            "exit_multiplier": None
        })
        player["state"] = "cashedout"
        player["exit_multiplier"] = round(multiplier, 2) if multiplier > 0 else None

    emit_players_update()


@socketio.on("disconnect")
def handle_disconnect():
    with players_lock:
        connected_players.pop(request.sid, None)

    emit_players_update()


if __name__ == "__main__":
    t = threading.Thread(target=game_loop, daemon=True)
    t.start()
    radio_thread = threading.Thread(target=radio_loop, daemon=True)
    radio_thread.start()
    socketio.run(app, debug=True, host="0.0.0.0", port=5000, use_reloader=False, allow_unsafe_werkzeug=True)
