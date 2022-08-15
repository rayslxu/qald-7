import sys

path1 = './experiments/' + sys.argv[2] + '/' + sys.argv[1] + '.debug'
path2 = './experiments/' + sys.argv[3] + '/' + sys.argv[1] + '.debug'

failed_example1 = []
with open(path1, 'r') as f1:
    for line in f1:
        id = line.split('\t')[0]
        failed_example1.append(id)

failed_example2 = []
with open(path2, 'r') as f2:
    for line in f2:
        id = line.split('\t')[0]
        failed_example2.append(id)


for id in failed_example2:
    if id not in failed_example1:
        print(id)
