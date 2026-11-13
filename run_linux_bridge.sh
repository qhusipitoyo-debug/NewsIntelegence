#!/usr/bin/env bash
# ==============================================================================
# NewsIntelegence - MT5 Linux Bottles Auto-Bridge Launcher
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=================================================================="
echo "    🚀 Memulai NewsIntelegence MT5 Bridge di Linux (Bottles)    "
echo "=================================================================="

# 1. Cek apakah terminal MT5 aktif
if pgrep -f "terminal64.exe" > /dev/null; then
    echo "✅ MT5 Terminal terdeteksi sedang berjalan di Linux."
else
    echo "⚠️ MT5 Terminal belum berjalan."
    echo "👉 Silakan buka Bottles dan jalankan MT5 (FBS Demo), lalu jalankan script ini kembali."
fi

# 2. Cek apakah Python 3 tersedia
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 tidak ditemukan. Silakan pasang python3."
    exit 1
fi

# 3. Jalankan bridge daemon
echo "📡 Menghubungkan ke folder MQL5/Files di Bottle..."
exec python3 "$DIR/scripts/mt5_linux_bridge.py" --daemon
