#!/bin/bash


FAILED=$(cat .active_environment)


if [ "$FAILED" = "green" ]

then

GOOD=blue

else

GOOD=green

fi



echo "Rollback"

echo "Restoring $GOOD"



./deploy/switch-traffic.sh $GOOD


docker compose \
-f docker-compose.$FAILED.yml \
down



echo $GOOD > .active_environment


echo "Rollback completed"
