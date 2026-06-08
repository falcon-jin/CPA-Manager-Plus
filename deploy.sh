#!/bin/bash


docker build -f Dockerfile.manager-server -t registry.cn-hangzhou.aliyuncs.com/falcon-tools/cpa-manager-plus:latest --network host .
docker push registry.cn-hangzhou.aliyuncs.com/falcon-tools/cpa-manager-plus:latest
