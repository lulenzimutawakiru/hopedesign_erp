#!/bin/bash

set -e


APP=/opt/hopedesign_erp

cd $APP


echo "================================"
echo "BLUE/GREEN DEPLOYMENT START"
echo "================================"


CURRENT=$(cat .active_environment 2>/dev/null || echo blue)


if [ "$CURRENT" = "blue" ]
then

NEW=green

else

NEW=blue

fi


echo "Current: $CURRENT"
echo "Deploying: $NEW"



echo "[1] Database backup"

./deploy/backup-manager.sh



echo "[2] Pull latest code"

git pull origin main



echo "[3] Build new image"

docker build \
-t hopedesign-erp-api:$NEW \
-f Dockerfile .



echo "[4] Start new environment"


docker compose \
-f docker-compose.$NEW.yml \
up -d



echo "[5] Health check"


./deploy/health-check-$NEW.sh



echo "[6] Switching traffic"


./deploy/switch-traffic.sh $NEW



echo $NEW > .active_environment



echo "DEPLOYMENT SUCCESS"
