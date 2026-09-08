#!/bin/bash

set -e


echo "Checking GREEN environment"


for i in {1..30}

do


STATUS=$(curl -s \
-o /dev/null \
-w "%{http_code}" \
http://localhost:4001/health)



if [ "$STATUS" = "200" ]

then

echo "GREEN healthy"

exit 0

fi


echo "Waiting..."

sleep 5


done



echo "GREEN FAILED"

exit 1
