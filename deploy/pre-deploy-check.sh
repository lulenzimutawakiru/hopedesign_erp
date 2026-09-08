#!/bin/bash

set -e

echo "================================"
echo "PRE DEPLOYMENT CHECK"
echo "================================"


echo "[1] Checking disk space"

AVAILABLE=$(df / | awk 'NR==2 {print $4}')

if [ "$AVAILABLE" -lt 5000000 ]
then
    echo "ERROR: Low disk space"
    exit 1
fi


echo "[2] Checking Docker"

docker info >/dev/null || {
echo "Docker unavailable"
exit 1
}


echo "[3] Checking environment"

if [ ! -f .env.production ]
then
echo ".env.production missing"
exit 1
fi


echo "[4] Checking containers"

docker ps >/dev/null


echo "PRECHECK PASSED"#!/bin/bash

set -e

echo "================================"
echo "PRE DEPLOYMENT CHECK"
echo "================================"


echo "[1] Checking disk space"

AVAILABLE=$(df / | awk 'NR==2 {print $4}')

if [ "$AVAILABLE" -lt 5000000 ]
then
    echo "ERROR: Low disk space"
    exit 1
fi


echo "[2] Checking Docker"

docker info >/dev/null || {
echo "Docker unavailable"
exit 1
}


echo "[3] Checking environment"

if [ ! -f .env.production ]
then
echo ".env.production missing"
exit 1
fi


echo "[4] Checking containers"

docker ps >/dev/null


echo "PRECHECK PASSED"
