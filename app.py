from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import random
import threading
import time
import uuid

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

current_round = None
round_history = []
connected_players = {}
players_lock = threading.Lock()
TICK_SECONDS = 0.05
MULTIPLIER_GROWTH = 1.012
BETTING_SECONDS = 5
POST_CRASH_SECONDS = 5
MAX_ROUND_HISTORY = 20


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

        multiplier = get_server_multiplier(current_round["started_at"])

        if multiplier >= current_round["crash_point"]:
            current_round["active"] = False
            current_round["crashed_at"] = time.time()
            add_round_history(current_round)
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


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("join")
def handle_join():
    global current_round

    if not current_round:
        current_round = create_round()
        emit_round_start()

    emit("round_state", get_round_state_payload())


@socketio.on("player_join")
def handle_player_join(data):
    nickname = normalize_nickname((data or {}).get("nickname"))

    with players_lock:
        existing = connected_players.get(request.sid, {})
        connected_players[request.sid] = {
            "nickname": nickname,
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
            "nickname": "Ospite",
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
            "nickname": "Ospite",
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
    socketio.run(app, debug=True, host="0.0.0.0", port=5000, use_reloader=False)
