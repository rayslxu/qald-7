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

model ?= 1
train_iterations ?= 30000
train_filter_iterations ?= 8000
train_save_every ?= 2000
train_log_every ?= 100
train_nlu_flags ?= \
	--model TransformerSeq2Seq \
	--pretrained_model facebook/bart-large \
	--eval_set_name eval \
	--train_batch_tokens 3500 \
	--val_batch_size 4000 \
	--preprocess_special_tokens \
	--warmup 800 \
	--lr_multiply 0.01 \
	--override_question= \
	--preserve_case
paraphrasing_flags ?= \
	--temperature 0 0.3 0.5 0.7 1.0 \
	--top_p 0.9 \
	--val_batch_size 4000
custom_train_nlu_flags ?=

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

manifest.tt: manifest-base.tt constants.tsv
	$(genie) auto-annotate -o $@ --constants constants.tsv --thingpedia manifest-base.tt $(annotate_flags) --dataset wikidata 

synthetic-d%.tsv: manifest.tt $(dataset_file) 
	$(genie) generate \
	  --thingpedia manifest.tt --entities entities.json --dataset $(dataset_file) \
	  --target-pruning-size $(pruning_size) \
	  -o $@.tmp $(generate_flags) --maxdepth $$(echo $* | cut -f1 -d'-') --random-seed $@ --debug 3
	mv $@.tmp $@

synthetic.tsv : $(foreach v,1 2 3,synthetic-d6-$(v).tsv) synthetic-d$(maxdepth).tsv
	cat $^ > $@

fewshot.tsv : manifest.tt
	node $(qald7dir)/dist/lib/converter.js --manifest manifest.tt -i $(qald7dir)/data/train.json --cache $(cache) -o $@

test.tsv : manifest.tt
	node $(qald7dir)/dist/lib/converter.js --manifest manifest.tt -i $(qald7dir)/data/test.json --cache $(cache) -o $@

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
	cp everything.tsv $@/train.tsv
	cut -f1-3 < test.tsv > $@/eval.tsv
	rm -rf $@/almond
	ln -sf . $@/almond
	touch $@

train: $(datadir)
	mkdir -p models/$(model)
	genienlp train \
	  --no_commit \
	  --data $(datadir) \
	  --embeddings .embeddings \
	  --save models/$(model) \
	  --tensorboard_dir models/$(model) \
	  --cache $(datadir)/.cache \
	  --train_tasks almond \
	  --preserve_case \
	  --train_iterations $(train_iterations) \
	  --save_every $(train_save_every) \
	  --log_every $(train_log_every) \
	  --val_every $(train_save_every) \
	  --exist_ok \
	  --skip_cache \
	  $(train_nlu_flags) \
	  $(custom_train_nlu_flags)

clean:
	rm -rf datadir emptydataset.tt synthetic* data.json entities.json parameter-datasets* manifest.tt manifest-base.tt augmented.tsv constants.tsv
