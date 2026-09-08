#!/bin/bash

set -e

echo "================================"
echo " ERP HEALTH CHECK"
echo "================================"

SERVICES="
hopedesign-erp-api-1
hopedesign-erp-web-1
hopedesign-erp-postgres-1
hopedesign-erp-caddy-1
"


for service in $SERVICES
do

    if docker ps --format "{{.Names}}" | grep -q "$service"
    then
        echo "OK: $service"
    else
        echo "FAILED: $service"
        exit 1
    fi

done


echo ""
echo "Checking HTTP..."

if curl -f http://localhost > /dev/null 2>&1
then
    echo "OK: Web service"
else
    echo "FAILED: Web service"
    exit 1
fi


echo ""
echo "SYSTEM HEALTH OK"
