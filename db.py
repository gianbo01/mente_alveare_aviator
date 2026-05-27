import sqlite3
import time


DB_PATH = "aviator.db"


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                balance REAL NOT NULL DEFAULT 1000.0,
                created_at REAL NOT NULL
            )
        """)


def get_user_by_username(username):
    with get_connection() as connection:
        return connection.execute(
            "SELECT * FROM users WHERE username = ?",
            (username,)
        ).fetchone()


def get_user_by_id(user_id):
    with get_connection() as connection:
        return connection.execute(
            "SELECT * FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()


def create_user(username, password_hash):
    with get_connection() as connection:
        cursor = connection.execute(
            "INSERT INTO users (username, password_hash, balance, created_at) VALUES (?, ?, ?, ?)",
            (username, password_hash, 1000.0, time.time())
        )
        return cursor.lastrowid


def get_balance(user_id):
    user = get_user_by_id(user_id)
    return float(user["balance"]) if user else 0.0


def update_balance(user_id, new_balance):
    with get_connection() as connection:
        connection.execute(
            "UPDATE users SET balance = ? WHERE id = ?",
            (float(new_balance), user_id)
        )
