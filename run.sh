#!/usr/bin/env bash
# Startup script for Muse2 LSL Gateway

set -e

# Get directory of this script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "================================================="
echo "       Starting Muse2 LSL Gateway Server"
echo "================================================="

# Locate Python executable within the virtual environment
if [ -x "$DIR/venv/bin/python" ]; then
    PYTHON_BIN="$DIR/venv/bin/python"
elif [ -x "$DIR/venv/bin/python3" ]; then
    PYTHON_BIN="$DIR/venv/bin/python3"
else
    echo "Error: Python executable not found in '$DIR/venv/bin'."
    echo "Please set up the virtual environment first:"
    echo "  python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
    exit 1
fi

# Ensure LSL configuration is set for local multi-stream discovery
export LSLAPICFG="${LSLAPICFG:-$DIR/lsl_api.cfg}"

# Activate virtual environment if script exists
if [ -f "$DIR/venv/bin/activate" ]; then
    echo "Activating virtual environment..."
    source "$DIR/venv/bin/activate"
fi

PORT="${1:-${PORT:-8000}}"
HOST="${HOST:-0.0.0.0}"

echo "Launching FastAPI server on http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
echo "-------------------------------------------------"

# Run uvicorn server directly with the virtualenv Python interpreter
exec "$PYTHON_BIN" -m uvicorn backend.main:app --host "$HOST" --port "$PORT" --reload
