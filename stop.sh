#!/usr/bin/env bash
# Script to stop the FastAPI/uvicorn server and any active muselsl stream processes
# Use: ./stop.sh
echo "Stopping FastAPI server..."
pkill -f "uvicorn"
echo "Stopping any active muselsl streaming processes..."
pkill -f "muselsl"
echo "Done."

