#!/bin/bash
cd "$(dirname "$0")"
echo "جاري تثبيت المكتبات..."
npm install --silent 2>/dev/null || true
node checker.js
