geniedir ?= ../node_modules/genie-toolkit
qald7dir ?= ..

-include ./config.mk

memsize := 12000
genie = node --experimental_worker --max_old_space_size=$(memsize) $(geniedir)/dist/tool/genie.js

owner ?= silei
project = qald7
dataset_file = emptydataset.tt
synthetic_flags ?= \
	projection_with_filter \
	projection \
	aggregation \
	schema_org \
	filter_join

fewshot ?= true

paraphraser_options ?= --paraphraser-model ./models/paraphraser-bart-large-speedup-megabatch-5m --batch-size 32

annotation ?= baseline
baseline_annotate_flags =
auto_annotate_flags = --algorithms bart-paraphrase $(paraphraser_options)
annotate_flags ?= $($(annotation)_annotate_flags)

pruning_size ?= 100
maxdepth ?= 8

cache ?= ../wikidata_cache.sqlite

.PHONY: clean train
.SECONDARY:

models/paraphraser-bart-large-speedup-megabatch-5m:
	mkdir -p models
	curl -O https://almond-static.stanford.edu/test-data/paraphraser-bart-large-speedup-megabatch-5m.tar.xz
	tar -C models -xvf paraphraser-bart-large-speedup-megabatch-5m.tar.xz

emptydataset.tt:
	echo 'dataset @empty {}' > $@

manifest-base.tt: 
	mkdir -p parameter-datasets
	node $(qald7dir)/dist/lib/manifest-generator.js --cache $(cache) -o $@

constants.tsv: manifest-base.tt
	$(genie) sample-constants -o $@ --thingpedia manifest-base.tt --parameter-datasets parameter-datasets.tsv 
	cat $(geniedir)/data/en-US/constants.tsv >> $@

manifest.tt: manifest-base.tt constants.tsv models/paraphraser-bart-large-speedup-megabatch-5m
	$(genie) auto-annotate -o $@ --constants constants.tsv --thingpedia manifest-base.tt $(annotate_flags) --dataset wikidata 

synthetic-d%.tsv: manifest.tt $(dataset_file) 
	$(genie) generate \
	  --thingpedia manifest.tt --entities entities.json --dataset $(dataset_file) \
	  --target-pruning-size $(pruning_size) \
	  -o $@.tmp $(generate_flags) --maxdepth $$(echo $* | cut -f1 -d'-') --random-seed $@ --debug 3
	mv $@.tmp $@

synthetic.tsv : $(foreach v,1 2 3,synthetic-d6-$(v).tsv) synthetic-d$(maxdepth).tsv
	cat $^ > $@

fewshot.tsv : manifest.tt $(qald7dir)
	node $(qald7dir)/dist/lib/converter.js --manifest manifest.tt --cache $(cache) -i $(qald7dir)/data/train.json -d train-dripped.tsv -o $@.tmp
	$(genie) typecheck \
	  -o $@ \
	  --dropped fewshot_dropped.tsv \
	  --thingpedia manifest.tt \
	  --include-entity-value \
	  $@.tmp
	rm $@.tmp

test.tsv : manifest.tt ${qald7dir}
	mkdir -p test
	node $(qald7dir)/dist/lib/converter.js --manifest manifest.tt --cache $(cache) -i $(qald7dir)/data/test.json  -d test-dropped.tsv -o $@.tmp
	$(genie) typecheck \
	  -o $@ \
	  --dropped test_dropped.tsv \
	  --thingpedia manifest.tt \
	  --include-entity-value \
	  $@.tmp
	rm $@.tmp

everything.tsv: synthetic.tsv $(if $(findstring true,$(fewshot)),fewshot.tsv,)
	$(genie) augment \
	  -o $@.tmp \
	  -l en-US \
	  --thingpedia manifest.tt \
	  --parameter-datasets parameter-datasets.tsv \
	  --synthetic-expand-factor 1 \
	  --quoted-paraphrasing-expand-factor 60 \
	  --no-quote-paraphrasing-expand-factor 20 \
	  --quoted-fraction 0.0 \
	  --debug \
	  --no-requotable \
	  $(if $(findstring true,$(fewshot)),fewshot.tsv,) synthetic.tsv
	mv $@.tmp $@

datadir: everything.tsv test.tsv
	mkdir -p $@
	node $(qald7dir)/dist/lib/post-processor.js --thingpedia manifest.tt -i everything.tsv -o $@/train.tsv
	node $(qald7dir)/dist/lib/post-processor.js --thingpedia manifest.tt -i test.tsv -o $@/test.tsv
	touch $@

clean:
	rm -frv !("Makefile")
