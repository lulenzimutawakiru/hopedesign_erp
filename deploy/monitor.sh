#!/bin/bash


while true

do


echo "$(date)"


docker ps \
--format "{{.Names}} {{.Status}}"


MEM=$(free | awk '/Mem/ {print $3/$2 *100}')


echo "Memory usage: $MEM%"


DISK=$(df / | awk 'NR==2 {print $5}')


echo "Disk usage: $DISK"


sleep 60


done
