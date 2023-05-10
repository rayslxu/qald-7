import argparse
from refined.inference.processor import Refined
import json

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input_file')
    parser.add_argument('--model', default='questions_model', help="the name of the model or a path to the finetuned model")
    args = parser.parse_args()

    output = {}

    refined = Refined.from_pretrained(model_name='questions_model',
                                      entity_set="wikidata",
                                      download_files=True,
                                      use_precomputed_descriptions=True)

    with open(args.input_file) as file:
        for line in file.readlines():
            _id, utterance, thingtalk = line.strip().split('\t')
            output[_id] = []

            spans = refined.process_text(utterance)
            for span in spans:
                if span.predicted_entity.wikidata_entity_id:
                    output[_id].append(span.predicted_entity.wikidata_entity_id)
    
    print(json.dumps(output))