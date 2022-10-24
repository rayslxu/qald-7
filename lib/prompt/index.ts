import fs from 'fs';
import * as argparse from 'argparse';
import csvparse from 'csv-parse';
import { StreamUtils } from 'genie-toolkit';
import { Linker } from '../ner/base';
import { Falcon } from '../ner/falcon';
import { OracleLinker } from '../ner/oracle';

const PROMPT_SEP_TOKENS = '#';
const PROMPT_END_TOKENS = '\n#\n\n';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Generate prompt for GPT-3"
    });
    parser.add_argument('-i', '--input', {
        help: "the file to be processed",
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        help: "the file to write the processed data",
        type: fs.createWriteStream
    });
    parser.add_argument('--module', {
        required: false,
        default: 'falcon',
        help: "the NER module to load",
        choices: ['falcon', 'oracle'],
    });
    parser.add_argument('--ner-cache', {
        required: false,
        help: `the path to the cache db, default to the module name if absent`
    });
    parser.add_argument('--wikidata-cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg', {
        required: false,
        default: 'bootleg.sqlite'
    });

    const args = parser.parse_args();
    if (!args.ner_cache)
        args.ner_cache = args.module + '.sqlite';

    let linker : Linker;
    if (args.module === 'falcon') 
        linker = new Falcon(args);
    else if (args.module === 'oracle')
        linker = new OracleLinker(args);
    else
        throw new Error('Unknown NER module');

    const columns = ['id', 'utterance', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    for (const ex of data.values()) {
        const prompt = [];
        prompt.push('Question: ' + ex.utterance);
        prompt.push(PROMPT_SEP_TOKENS);
        prompt.push('Entities:');
        const result = await linker.run(ex.utterance, ex.thingtalk);
        for (const entity of result.entities) {
            let entityInfo = entity.label;
            if (entity.domain)
                entityInfo += ` ( ${entity.domain} )`;
            entityInfo += `: ${entity.id}`;
            prompt.push(entityInfo);
        }
        if (result.relations.length > 0) 
            prompt.push(PROMPT_SEP_TOKENS);
        for (const property of result.relations)
            prompt.push(`${property.label}: property.id`);
        prompt.push(PROMPT_END_TOKENS);
        args.output.write(JSON.stringify({
            prompt: prompt.join('\n'),
            completion: ex.thingtalk
        }) + '\n');
    }
    StreamUtils.waitEnd(dataset);
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();