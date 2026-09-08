#!/bin/bash

set -Eeuo pipefail


#############################################
# HOPE DESIGN ERP AUTOMATED DEPLOYMENT
#############################################


APP_DIR="/opt/hopedesign_erp"

BRANCH="main"

COMPOSE_FILE="docker-compose.prod.yml"

ENV_FILE=".env.production"


API="hopedesign-erp-api-1"
WEB="hopedesign-erp-web-1"
DB="hopedesign-erp-postgres-1"


DB_USER="hopedesign"
DB_NAME="hopedesign_erp"


BACKUP_DIR="$APP_DIR/backups"

LOG_DIR="$APP_DIR/logs"

LOCK_FILE="/tmp/hopedesign-erp-deploy.lock"


DATE=$(date +"%Y-%m-%d_%H-%M-%S")

LOG_FILE="$LOG_DIR/deploy_$DATE.log"



mkdir -p "$BACKUP_DIR"
mkdir -p "$LOG_DIR"



exec > >(tee -a "$LOG_FILE") 2>&1



#############################################
# LOCK DEPLOYMENT
#############################################

if [ -f "$LOCK_FILE" ]; then

echo "Another deployment is running"

exit 1

fi


touch "$LOCK_FILE"


cleanup()
{
rm -f "$LOCK_FILE"
}


trap cleanup EXIT



#############################################
# ERROR HANDLER
#############################################

OLD_COMMIT=""



rollback()
{

echo "================================"
echo "DEPLOYMENT FAILED"
echo "ROLLBACK"
echo "================================"


if [ -n "$OLD_COMMIT" ]; then

git checkout "$OLD_COMMIT"

fi


docker compose \
--env-file "$ENV_FILE" \
-f "$COMPOSE_FILE" \
up -d


echo "Rollback finished"

}



trap rollback ERR



#############################################
# START
#############################################


echo "================================="
echo "HOPE DESIGN ERP DEPLOYMENT"
echo "$DATE"
echo "================================="



cd "$APP_DIR"



#############################################
# SERVER CHECK
#############################################

echo "[1] Server check"


DISK=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')


if [ "$DISK" -gt 90 ]; then

echo "Disk full: $DISK%"

exit 1

fi



#############################################
# CURRENT VERSION
#############################################

echo "[2] Saving current version"


OLD_COMMIT=$(git rev-parse HEAD)


echo "$OLD_COMMIT"



#############################################
# UPDATE CODE
#############################################

echo "[3] Git update"


git fetch origin


git checkout "$BRANCH"


git pull origin "$BRANCH"



NEW_VERSION=$(git rev-parse HEAD)


echo "New version:"
echo "$NEW_VERSION"



#############################################
# DATABASE BACKUP
#############################################

echo "[4] Database backup"


DB_BACKUP="$BACKUP_DIR/db_$DATE.sql"


docker exec "$DB" \
pg_dump \
-U "$DB_USER" \
"$DB_NAME" \
> "$DB_BACKUP"



echo "Database backup:"
echo "$DB_BACKUP"



#############################################
# UPLOAD BACKUP
#############################################

echo "[5] Upload backup"


if [ -d "$APP_DIR/storage" ]; then

tar -czf \
"$BACKUP_DIR/storage_$DATE.tar.gz" \
"$APP_DIR/storage"

fi



#############################################
# MIGRATION
#############################################

echo "[6] Database migration"


docker exec "$API" npm run db:migrate



#############################################
# BUILD
#############################################

echo "[7] Building images"


docker compose \
--env-file "$ENV_FILE" \
-f "$COMPOSE_FILE" \
build



#############################################
# DEPLOY
#############################################

echo "[8] Starting containers"


docker compose \
--env-file "$ENV_FILE" \
-f "$COMPOSE_FILE" \
up -d



#############################################
# HEALTH CHECK
#############################################

echo "[9] Health check"


sleep 30



API_STATUS=$(docker inspect \
-f '{{.State.Health.Status}}' \
"$API")



if [ "$API_STATUS" != "healthy" ]; then

echo "API failed"

exit 1

fi



WEB_STATUS=$(docker inspect \
-f '{{.State.Health.Status}}' \
"$WEB" || echo "unknown")



echo "API:"
echo "$API_STATUS"

echo "WEB:"
echo "$WEB_STATUS"



#############################################
# CLEAN
#############################################

echo "[10] Cleanup"


docker image prune -f



find "$BACKUP_DIR" \
-type f \
-mtime +30 \
-delete



#############################################
# SUCCESS
#############################################


echo ""
echo "================================="
echo "DEPLOYMENT SUCCESSFUL"
echo "================================="


echo "Version:"
git rev-parse HEAD


echo "Completed:"
date



#############################################
# OPTIONAL TELEGRAM
#############################################

# curl -s \
# -X POST \
# https://api.telegram.org/botTOKEN/sendMessage \
# -d chat_id=CHAT_ID \
# -d text="ERP deployment successful"



exit 0
