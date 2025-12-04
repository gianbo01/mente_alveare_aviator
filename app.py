from flask import Flask, render_template, jsonify
import random
import time

app = Flask(__name__)


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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/round")
def api_round():
    crash_point = generate_crash_point()
    
    return jsonify({
        "crash_point": crash_point,
        "server_time": time.time()
    })


if __name__ == "__main__":
    app.run(debug=True)
