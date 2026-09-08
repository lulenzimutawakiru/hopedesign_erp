[201~#!/bin/bash

set -e


BACKUP_DIR="/opt/hopedesign_erp/backups"

DATE=$(date +"%Y-%m-%d_%H-%M")


mkdir -p $BACKUP_DIR


echo "Creating database backup"


docker exec hopedesign-erp-postgres-1 \
pg_dump \
-U hopedesign \
hopedesign_erp \
> $BACKUP_DIR/db_$DATE.sql


echo "Compressing backup"

gzip $BACKUP_DIR/db_$DATE.sql



echo "Removing backups older than 30 days"

find $BACKUP_DIR \
-type f \
-mtime +30 \
-delete


echo "Backup completed"
