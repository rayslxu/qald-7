#!/bin/bash

aws s3 cp s3://geniehai/silei/workdir/qald/test/silei/$1/$2.results experiments/$2/test.results
aws s3 cp s3://geniehai/silei/workdir/qald/test/silei/$1/$2.debug experiments/$2/test.debug
