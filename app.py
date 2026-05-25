from flask import Flask, render_template, jsonify, request
import random
import time
import uuid

app = Flask(__name__)

rounds = {}
ROUND_TTL_SECONDS = 120


def generate_crash_point():
    """
    Genera il punto di crash (tipo Aviator).
    Più il numero è alto, più il furgone vola a lungo.
    Qui limitiamo a max 10x, giusto per demo.
    """
    r = random.random()
    # Formula semplice stile aviator-like
    crash = 1 / (1 - r)
    crash = min(crash, 100)  # limite massimo
    return round(crash, 2)


def cleanup_old_rounds():
    now = time.time()
    expired_round_ids = [
        round_id
        for round_id, round_data in rounds.items()
        if now - round_data["started_at"] > ROUND_TTL_SECONDS
    ]

    for round_id in expired_round_ids:
        rounds.pop(round_id, None)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/round", methods=["POST"])
def api_round():
    cleanup_old_rounds()

    round_id = str(uuid.uuid4())
    crash_point = generate_crash_point()

    rounds[round_id] = {
        "active": True,
        "crash_point": crash_point,
        "started_at": time.time()
    }
    
    return jsonify({
        "round_id": round_id,
        "server_time": time.time()
    })


@app.route("/api/check", methods=["POST"])
def api_check():
    data = request.get_json(silent=True) or {}
    round_id = data.get("round_id")

    try:
        current_multiplier = float(data.get("current_multiplier", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "current_multiplier non valido"}), 400

    round_data = rounds.get(round_id)

    if not round_data:
        return jsonify({"crashed": True})

    if not round_data["active"]:
        return jsonify({
            "crashed": True,
            "crash_point": round_data["crash_point"]
        })

    if current_multiplier >= round_data["crash_point"]:
        round_data["active"] = False

        return jsonify({
            "crashed": True,
            "crash_point": round_data["crash_point"]
        })

    return jsonify({"crashed": False})


if __name__ == "__main__":
    app.run(debug=True)
