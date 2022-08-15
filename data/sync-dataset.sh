#!/bin/bash

# args: s3-dir dataset-name
aws s3 sync $1 experiments/$2 --exclude "chunked/*"
