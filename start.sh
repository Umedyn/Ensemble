#!/usr/bin/env sh
cd "$(dirname "$0")"
( sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:8000 || open http://localhost:8000 ) >/dev/null 2>&1 &
if command -v node >/dev/null; then exec node tools/serve.mjs; fi
echo "Ensemble is running at http://localhost:8000  (Ctrl+C to stop)"
exec python3 -m http.server 8000
