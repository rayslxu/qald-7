#!/bin/bash

# args: eval/test id model-name
# e.g., `./sync-result.sh test 1664299068 24`

bucket=https://nfs009a5d03c43b4e7e8ec2.blob.core.windows.net/pvc-a8853620-9ac7-4885-a30e-0ec357f17bb6
azcopy cp ${bucket}/silei/workdir/qald/$1/silei/$2/$3.results experiments/$3/$1.results
azcopy cp ${bucket}/silei/workdir/qald/$1/silei/$2/$3.debug experiments/$3/$1.debug