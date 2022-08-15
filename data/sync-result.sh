#!/bin/bash

# args: eval/test id model-name
aws s3 cp s3://geniehai/silei/workdir/qald/$1/silei/$2/$3.results experiments/$3/$1.results
aws s3 cp s3://geniehai/silei/workdir/qald/$1/silei/$2/$3.debug experiments/$3/$1.debug
