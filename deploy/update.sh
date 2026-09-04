#!/bin/bash

set -e

############################################
# HOPE DESIGN ERP PRODUCTION DEPLOY SCRIPT
############################################

APP_DIR="/opt/hopedesign_erp"

BRANCH="main"

COMPOSE_FILE="docker-compose.prod.yml"

ENV_FILE=".env.production"


API_CONTAINER="hopedesign-erp-api-1"

DB_CONTAINER="hopedesign-erp-postgres-1"


DB_USER="hopedesign"

DB_NAME="hopedesign_erp"


BACKUP_DIR="$APP_DIR/backups"


DATE=$(date +"%Y-%m-%d_%H-%M-%S")

DB_BACKUP="$BACKUP_DIR/db_$DATE.sql"


echo "======================================"
echo " HOPE DESIGN ERP DEPLOYMENT"
echo "======================================"


cd $APP_DIR


############################################
# CHECK ENVIRONMENT
############################################

echo "[1/10] Checking environment"


if [ ! -f "$ENV_FILE" ]; then

echo "ERROR: Missing $ENV_FILE"

exit 1

fi



############################################
# SAVE CURRENT VERSION
############################################

echo "[2/10] Saving current version"


OLD_COMMIT=$(git rev-parse HEAD)


echo "Current version:"
echo $OLD_COMMIT



############################################
# UPDATE CODE
############################################

echo "[3/10] Pulling latest code"


git fetch origin

git checkout $BRANCH

git pull origin $BRANCH



############################################
# DATABASE BACKUP
############################################

echo "[4/10] Creating database backup"


mkdir -p $BACKUP_DIR


docker exec $DB_CONTAINER \
pg_dump \
-U $DB_USER \
$DB_NAME \
> $DB_BACKUP


echo "Backup:"
echo $DB_BACKUP



############################################
# DATABASE MIGRATION
############################################

echo "[5/10] Running database migrations"


if ! docker exec $API_CONTAINER npm run db:migrate

then

echo "Migration failed"

echo "Restoring code"


git checkout $OLD_COMMIT


echo "Deployment stopped"

exit 1

fi



############################################
# BUILD IMAGES
############################################

echo "[6/10] Building Docker images"


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
build



############################################
# START SERVICES
############################################

echo "[7/10] Starting ERP"


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
up -d



############################################
# HEALTH CHECK
############################################

echo "[8/10] Waiting for services"


sleep 20


API_STATUS=$(docker inspect \
-f '{{.State.Health.Status}}' \
$API_CONTAINER)



if [ "$API_STATUS" != "healthy" ]

then

echo "API health check failed"


echo "Rolling back..."


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
down


git checkout $OLD_COMMIT


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
up -d


echo "Rollback completed"


exit 1

fi



############################################
# VERIFY CONTAINERS
############################################

echo "[9/10] Checking containers"


docker ps \
--format "table {{.Names}}\t{{.Status}}"



############################################
# CLEANUP
############################################

echo "[10/10] Cleaning Docker"


docker image prune -f



echo ""
echo "======================================"
echo " DEPLOYMENT SUCCESSFUL"
echo "======================================"

echo "Version:"
git rev-parse HEAD

echo "Completed:"
date#!/bin/bash

set -e

############################################
# HOPE DESIGN ERP PRODUCTION DEPLOY SCRIPT
############################################

APP_DIR="/opt/hopedesign_erp"

BRANCH="main"

COMPOSE_FILE="docker-compose.prod.yml"

ENV_FILE=".env.production"


API_CONTAINER="hopedesign-erp-api-1"

DB_CONTAINER="hopedesign-erp-postgres-1"


DB_USER="hopedesign"

DB_NAME="hopedesign_erp"


BACKUP_DIR="$APP_DIR/backups"


DATE=$(date +"%Y-%m-%d_%H-%M-%S")

DB_BACKUP="$BACKUP_DIR/db_$DATE.sql"


echo "======================================"
echo " HOPE DESIGN ERP DEPLOYMENT"
echo "======================================"


cd $APP_DIR


############################################
# CHECK ENVIRONMENT
############################################

echo "[1/10] Checking environment"


if [ ! -f "$ENV_FILE" ]; then

echo "ERROR: Missing $ENV_FILE"

exit 1

fi



############################################
# SAVE CURRENT VERSION
############################################

echo "[2/10] Saving current version"


OLD_COMMIT=$(git rev-parse HEAD)


echo "Current version:"
echo $OLD_COMMIT



############################################
# UPDATE CODE
############################################

echo "[3/10] Pulling latest code"


git fetch origin

git checkout $BRANCH

git pull origin $BRANCH



############################################
# DATABASE BACKUP
############################################

echo "[4/10] Creating database backup"


mkdir -p $BACKUP_DIR


docker exec $DB_CONTAINER \
pg_dump \
-U $DB_USER \
$DB_NAME \
> $DB_BACKUP


echo "Backup:"
echo $DB_BACKUP



############################################
# DATABASE MIGRATION
############################################

echo "[5/10] Running database migrations"


if ! docker exec $API_CONTAINER npm run db:migrate

then

echo "Migration failed"

echo "Restoring code"


git checkout $OLD_COMMIT


echo "Deployment stopped"

exit 1

fi



############################################
# BUILD IMAGES
############################################

echo "[6/10] Building Docker images"


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
build



############################################
# START SERVICES
############################################

echo "[7/10] Starting ERP"


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
up -d



############################################
# HEALTH CHECK
############################################

echo "[8/10] Waiting for services"


sleep 20


API_STATUS=$(docker inspect \
-f '{{.State.Health.Status}}' \
$API_CONTAINER)



if [ "$API_STATUS" != "healthy" ]

then

echo "API health check failed"


echo "Rolling back..."


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
down


git checkout $OLD_COMMIT


docker compose \
--env-file $ENV_FILE \
-f $COMPOSE_FILE \
up -d


echo "Rollback completed"


exit 1

fi



############################################
# VERIFY CONTAINERS
############################################

echo "[9/10] Checking containers"


docker ps \
--format "table {{.Names}}\t{{.Status}}"



############################################
# CLEANUP
############################################

echo "[10/10] Cleaning Docker"


docker image prune -f



echo ""
echo "======================================"
echo " DEPLOYMENT SUCCESSFUL"
echo "======================================"

echo "Version:"
git rev-parse HEAD

echo "Completed:"
date
