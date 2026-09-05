#!/bin/bash
# Startup script for Muse2 LSL Gateway

# Get directory of this script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "================================================="
echo "       Starting Muse2 LSL Gateway Server"
echo "================================================="

if [ ! -d "venv" ]; then
    echo "Error: Virtual environment 'venv' not found."
    echo "Please set up the environment before running."
    exit 1
fi

echo "Activating virtual environment..."
source venv/bin/activate

echo "Launching FastAPI server on http://localhost:8000"
echo "Press Ctrl+C to stop."
echo "-------------------------------------------------"

# Run uvicorn server
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
