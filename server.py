# -*- coding: utf-8 -*-
"""
局域网文件接收平台

运行方式:
    python server.py            # 使用 config.json 配置
    python server.py --port 9000
    python server.py --open     # 启动后自动打开浏览器

其他电脑在浏览器中访问 http://本机IP:端口 即可上传文件。
"""

import argparse
import io
import json
import os
import re
import socket
import sys
import threading
import webbrowser
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.serving import make_server

try:
    import qrcode
    HAVE_QR = True
except ImportError:  # 未安装 qrcode 时仅隐藏二维码
    HAVE_QR = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "host": "0.0.0.0",        # 监听所有网卡，局域网均可访问
    "port": 8000,             # 服务端口
    "upload_dir": "uploads",  # 接收文件的保存目录（相对本文件所在目录）
    "max_file_size_mb": 10240,  # 单次上传总大小上限(MB)，0 表示不限制
    "access_code": "",        # 访问码，留空表示不启用
    "recent_limit": 50,       # 页面“最近接收”最多显示条数
}


def load_config():
    """读取 config.json；不存在则生成默认配置。"""
    if not os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        except OSError:
            pass
        return dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        cfg = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg)
    return merged


CONFIG = load_config()
UPLOAD_DIR = os.path.join(BASE_DIR, str(CONFIG.get("upload_dir", "uploads")))
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_BYTES = int(CONFIG.get("max_file_size_mb", 10240)) * 1024 * 1024
RECENT_LIMIT = max(1, int(CONFIG.get("recent_limit", 50)))
ACCESS_CODE = str(CONFIG.get("access_code", "")).strip()

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES if MAX_BYTES > 0 else None

_lock = threading.Lock()
recent_files = []


def get_lan_ips():
    """获取本机局域网 IPv4 地址列表。"""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    # 通过 UDP “连接”拿到默认出口 IP（不实际发包）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    result = []
    for ip in sorted(ips):
        if ip.startswith("127.") or ip.startswith("169.254."):
            continue
        result.append(ip)
    return result


def build_url():
    ips = get_lan_ips()
    if ips:
        return "http://{}:{}/".format(ips[0], CONFIG.get("port", 8000))
    return "http://127.0.0.1:{}/".format(CONFIG.get("port", 8000))


def sanitize_filename(name):
    """清理文件名：保留中文，去除路径分隔符与非法字符。"""
    name = os.path.basename(name.replace("\\", "/")).strip()
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", name)
    name = name.lstrip(".").strip()
    if not name:
        name = "未命名文件"
    if len(name) > 180:
        root, ext = os.path.splitext(name)
        name = root[: 180 - len(ext)] + ext
    return name


def unique_path(directory, name):
    """同名文件自动追加 (1)、(2)... 避免覆盖。"""
    base, ext = os.path.splitext(name)
    candidate = name
    i = 1
    while os.path.exists(os.path.join(directory, candidate)):
        candidate = "{} ({}){}".format(base, i, ext)
        i += 1
    return os.path.join(directory, candidate)


def scan_existing():
    """启动时扫描 uploads 目录，历史文件也会显示在“最近接收”里。"""
    try:
        names = os.listdir(UPLOAD_DIR)
    except OSError:
        return
    items = []
    for n in names:
        p = os.path.join(UPLOAD_DIR, n)
        if not os.path.isfile(p):
            continue
        try:
            st = os.stat(p)
        except OSError:
            continue
        items.append({
            "name": n,
            "size": st.st_size,
            "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "ip": "-",
            "source": "history",
        })
    items.sort(key=lambda x: x["time"], reverse=True)
    with _lock:
        recent_files.extend(items)


scan_existing()


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/info")
def api_info():
    return jsonify({
        "server_name": socket.gethostname(),
        "ips": get_lan_ips(),
        "port": int(CONFIG.get("port", 8000)),
        "upload_dir": os.path.relpath(UPLOAD_DIR, BASE_DIR),
        "access_code_required": bool(ACCESS_CODE),
        "max_file_size_mb": int(CONFIG.get("max_file_size_mb", 0)),
    })


@app.route("/api/files")
def api_files():
    with _lock:
        items = recent_files[:RECENT_LIMIT]
    return jsonify({"files": items})


@app.route("/api/qr")
def api_qr():
    if not HAVE_QR:
        return "二维码功能未启用（缺少 qrcode 库）", 404
    img = qrcode.make(build_url())
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return (buf.getvalue(), 200, {"Content-Type": "image/png",
                                  "Cache-Control": "no-store"})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    if ACCESS_CODE:
        provided = request.form.get("code", "")
        if provided != ACCESS_CODE:
            return jsonify({"ok": False, "error": "访问码错误"}), 403

    files = request.files.getlist("files")
    if not files:
        return jsonify({"ok": False, "error": "没有收到文件"}), 400

    client_ip = request.remote_addr or "-"
    saved = []
    for f in files:
        if f is None or not f.filename:
            continue
        raw = f.filename
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        name = sanitize_filename(raw)
        dest = unique_path(UPLOAD_DIR, name)
        try:
            f.save(dest)
        except Exception as exc:  # 保存失败时记录错误，不中断其他文件
            saved.append({"name": name, "ok": False, "error": str(exc)})
            continue
        size = os.path.getsize(dest)
        with _lock:
            recent_files.insert(0, {
                "name": os.path.basename(dest),
                "size": size,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "ip": client_ip,
                "source": "live",
            })
            del recent_files[2000:]
        saved.append({"name": os.path.basename(dest), "ok": True, "size": size})

    return jsonify({"ok": True, "saved": saved})


@app.errorhandler(413)
def too_large(_e):
    limit = CONFIG.get("max_file_size_mb", 0)
    msg = "文件过大" + ("（单次上传总量上限 {} MB）".format(limit) if limit else "")
    return jsonify({"ok": False, "error": msg}), 413


def print_banner():
    port = int(CONFIG.get("port", 8000))
    ips = get_lan_ips()
    print()
    print("=" * 58)
    print("  局域网文件接收平台已启动")
    print("  保存目录: {}".format(os.path.abspath(UPLOAD_DIR)))
    if ACCESS_CODE:
        print("  访问码已启用（上传时需要填写）")
    else:
        print("  访问码: 未启用（局域网内任何人可上传）")
    print("-" * 58)
    if ips:
        for ip in ips:
            print("  访问地址: http://{}:{}/".format(ip, port))
    else:
        print("  访问地址: http://127.0.0.1:{}/".format(port))
    print("  按 Ctrl+C 停止服务")
    if HAVE_QR and ips:
        print("-" * 58)
        print("  手机扫码访问:")
        qr = qrcode.QRCode(border=1)
        qr.add_data(build_url())
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    print("=" * 58)
    print()


def main():
    parser = argparse.ArgumentParser(description="局域网文件接收平台")
    parser.add_argument("--port", type=int, help="覆盖配置文件中的端口")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    host = str(CONFIG.get("host", "0.0.0.0"))
    port = args.port or int(CONFIG.get("port", 8000))

    print_banner()
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(build_url())).start()

    try:
        server = make_server(host, port, app, threaded=True)
        server.serve_forever()
    except OSError as exc:
        print("启动失败: {}".format(exc))
        print("提示: 端口可能被占用，请修改 config.json 中的 port，或使用 --port 指定其他端口。")
        sys.exit(1)


if __name__ == "__main__":
    main()
