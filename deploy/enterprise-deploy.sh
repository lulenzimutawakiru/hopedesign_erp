[201~#!/bin/bash

set -e


cd /opt/hopedesign_erp


echo "================================"
echo "HOPE DESIGN ERP DEPLOYMENT"
echo "================================"


./deploy/pre-deploy-check.sh


./deploy/backup-manager.sh



git pull origin main



./deploy/migrate.sh



docker compose \
-f docker-compose.prod.yml \
--env-file .env.production \
build



docker compose \
-f docker-compose.prod.yml \
--env-file .env.production \
up -d



./deploy/health-check.sh



git rev-parse HEAD > .last_success



echo "DEPLOYMENT SUCCESS"

