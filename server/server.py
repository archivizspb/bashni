#!/usr/bin/env python3
"""Общая библиотека вариантов башен «Ленсити» (сайт archivizspb.github.io/bashni).

Только стандартная библиотека. Слушает 127.0.0.1, снаружи — через Caddy с HTTPS.
  GET    /api/variants        — все варианты (без ключей удаления)
  POST   /api/variants        — {name, author, params} -> {id, key, ...}; key нужен автору для удаления
  DELETE /api/variants/<id>   — заголовок X-Key: ключ автора или ключ владельца (/etc/bashni-api/admin.key)
"""
import json, os, secrets, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get("BASHNI_DATA", "/var/lib/bashni-api/variants.json")
ADMIN_KEY_FILE = os.environ.get("BASHNI_ADMIN_KEY", "/etc/bashni-api/admin.key")
PORT = int(os.environ.get("BASHNI_PORT", "8790"))
ORIGINS = {"https://archivizspb.github.io", "http://localhost:3017", "http://127.0.0.1:3017"}
MAX_VARIANTS = 1000
MAX_BODY = 4096
POST_LIMIT = (30, 3600)  # не больше 30 сохранений в час с одного адреса

# допустимые параметры формы и их границы (как у ползунков на сайте, с запасом)
PARAMS = {
    "L": (40, 300), "W": (20, 200), "Sharp": (0.3, 1.2), "Gap": (0, 100), "CutAng": (-90, 90),
    "H1": (50, 1000), "H2": (50, 1000), "FloorH": (2, 8), "Twist": (-360, 360), "Taper": (0.2, 3),
    "Inset": (0, 50), "CrownH": (0, 100), "CrownSlope": (-60, 60), "Podium": (0, 50),
    "BaseScale": (0.2, 3), "Bulge": (-1, 2), "BulgeZ": (0, 1000), "TipR": (0, 50), "Shrink": (0, 1),
    "RibD": (0, 20), "RibStep": (2, 40), "RibH": (0, 1000), "RibNose": (0, 200), "RibAsym": (0.3, 0.99),
    "PodSet": (0, 1), "PodK": (0.2, 1.5), "Sky": (0, 2),
}

lock = threading.Lock()
hits = {}


def load():
    try:
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save(items):
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, DATA)


def admin_key():
    try:
        with open(ADMIN_KEY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def clean_text(v, n):
    return " ".join(str(v or "").split())[:n]


def public(v):
    return {k: v[k] for k in ("id", "name", "author", "created", "params")}


class Handler(BaseHTTPRequestHandler):
    server_version = "bashni-api"

    def log_message(self, fmt, *args):  # без IP в журнале
        pass

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Key")
            self.send_header("Access-Control-Max-Age", "86400")

    def reply(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client(self):
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self):
        if self.path.split("?")[0] != "/api/variants":
            return self.reply(404, {"error": "not_found"})
        with lock:
            items = load()
        self.reply(200, {"variants": [public(v) for v in items]})

    def do_POST(self):
        if self.path.split("?")[0] != "/api/variants":
            return self.reply(404, {"error": "not_found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self.reply(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            assert isinstance(body, dict)
        except Exception:
            return self.reply(400, {"error": "bad_json"})
        params = {}
        for k, v in (body.get("params") or {}).items():
            if k in PARAMS and isinstance(v, (int, float)) and PARAMS[k][0] <= v <= PARAMS[k][1]:
                params[k] = round(float(v), 4)
        name = clean_text(body.get("name"), 60) or "Вариант"
        author = clean_text(body.get("author"), 40)
        now = time.time()
        ip = self.client()
        with lock:
            recent = [t for t in hits.get(ip, []) if now - t < POST_LIMIT[1]]
            if len(recent) >= POST_LIMIT[0]:
                return self.reply(429, {"error": "rate_limited"})
            hits[ip] = recent + [now]
            items = load()
            if len(items) >= MAX_VARIANTS:
                return self.reply(507, {"error": "library_full"})
            v = {"id": secrets.token_urlsafe(8), "key": secrets.token_urlsafe(18), "name": name,
                 "author": author, "created": int(now * 1000), "params": params}
            items.append(v)
            save(items)
        out = public(v)
        out["key"] = v["key"]
        self.reply(201, out)

    def do_DELETE(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) != 3 or parts[:2] != ["api", "variants"]:
            return self.reply(404, {"error": "not_found"})
        key = self.headers.get("X-Key", "")
        adm = admin_key()
        with lock:
            items = load()
            hit = next((v for v in items if v["id"] == parts[2]), None)
            if hit is None:
                return self.reply(404, {"error": "not_found"})
            if not key or not (secrets.compare_digest(key, hit["key"]) or (adm and secrets.compare_digest(key, adm))):
                return self.reply(403, {"error": "forbidden"})
            save([v for v in items if v["id"] != parts[2]])
        self.reply(200, {"deleted": parts[2]})


if __name__ == "__main__":
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
