from refined.inference.processor import Refined

if __name__ == '__main__':
    refined = Refined.from_pretrained(model_name='questions_model',
                                      entity_set="wikidata",
                                      download_files=True,
                                      use_precomputed_descriptions=True)