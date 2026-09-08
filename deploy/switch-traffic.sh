#!/bin/bash


ENV=$1


if [ "$ENV" = "green" ]

then


echo "Switching traffic to GREEN"


sed -i \
's/api:4000/api:4001/' \
Caddyfile



else


echo "Switching traffic to BLUE"


sed -i \
's/api:4001/api:4000/' \
Caddyfile


fi



docker restart hopedesign-erp-caddy-1
