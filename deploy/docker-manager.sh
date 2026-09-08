#!/bin/bash


ACTION=$1


case $ACTION in


start)

docker compose \
-f docker-compose.prod.yml \
--env-file .env.production \
up -d

;;


stop)

docker compose \
-f docker-compose.prod.yml \
down

;;


restart)

docker compose \
-f docker-compose.prod.yml \
restart

;;


status)

docker ps

;;


logs)

docker compose \
-f docker-compose.prod.yml \
logs -f

;;


*)

echo "Usage:"
echo "$0 start|stop|restart|status|logs"

;;

esac
